import { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { users, sessions } from "../db/schema";
import { hashPassword, verifyPassword } from "../auth/password";
import { signAccessToken, generateRefreshToken, hashRefreshToken } from "../auth/tokens";
import { requireAuth, getUser } from "../auth/middleware";
import { rateLimit } from "../auth/rate-limit";
import { audit, clientIp } from "../lib/audit";
import { env } from "../lib/env";
import { log } from "../lib/logger";

const RegisterSchema = z.object({
  email: z.string().email().max(254),
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/, "alphanumeric, _, - only"),
  password: z.string().min(6).max(200),
});

const LoginSchema = z.object({
  identifier: z.string().min(1).max(254),  // email OR username
  password: z.string().min(1).max(200),
});

const RefreshSchema = z.object({
  refresh_token: z.string().min(32).max(200),
});

const router = new Hono();

router.post("/register", async (c) => {
  const ip = clientIp(c) ?? "anon";
  const rl = rateLimit(`register:${ip}`, 5, 60 * 60 * 1000);
  if (!rl.ok) return c.json({ error: "rate_limited", retry_after: rl.retryAfter }, 429);

  const body = await c.req.json().catch(() => null);
  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_input", details: parsed.error.flatten() }, 400);

  const { email, username, password } = parsed.data;
  const passwordHash = await hashPassword(password);

  try {
    const [user] = await db.insert(users).values({ email, username, passwordHash }).returning();
    if (!user) return c.json({ error: "register_failed" }, 500);
    await audit(c, { userId: user.id, action: "user.register" });
    return c.json({ id: user.id, email: user.email, username: user.username }, 201);
  } catch (e: any) {
    if (typeof e?.message === "string" && e.message.includes("users_email_lower_idx")) {
      return c.json({ error: "email_taken" }, 409);
    }
    if (typeof e?.message === "string" && e.message.includes("users_username_lower_idx")) {
      return c.json({ error: "username_taken" }, 409);
    }
    log.error("register_failed", { error: String(e) });
    return c.json({ error: "register_failed" }, 500);
  }
});

router.post("/login", async (c) => {
  const ip = clientIp(c) ?? "anon";
  const rl = rateLimit(`login:${ip}`, 10, 15 * 60 * 1000);
  if (!rl.ok) return c.json({ error: "rate_limited", retry_after: rl.retryAfter }, 429);

  const body = await c.req.json().catch(() => null);
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

  const { identifier, password } = parsed.data;
  const lower = identifier.toLowerCase();
  const [user] = await db.select().from(users).where(
    sql`lower(${users.email}) = ${lower} or lower(${users.username}) = ${lower}`
  ).limit(1);

  // Constant-time-ish: always run verify, even if user is null, to reduce timing leaks.
  const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, "$argon2id$v=19$m=19456,t=2,p=1$invalid$invalid");
  if (!user || !ok) {
    await audit(c, { action: "user.login.failed", metadata: { identifier: lower } });
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const tokens = await issueTokens(c, user.id, user.username);
  await audit(c, { userId: user.id, action: "user.login" });
  return c.json({
    user: { id: user.id, email: user.email, username: user.username },
    ...tokens,
  });
});

router.post("/refresh", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = RefreshSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

  const presented = parsed.data.refresh_token;
  const presentedHash = await hashRefreshToken(presented);

  const [session] = await db.select().from(sessions).where(
    and(eq(sessions.refreshTokenHash, presentedHash), isNull(sessions.revokedAt))
  ).limit(1);

  if (!session || session.expiresAt.getTime() < Date.now()) {
    return c.json({ error: "invalid_refresh" }, 401);
  }

  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user) return c.json({ error: "invalid_refresh" }, 401);

  // Rotate: revoke current, issue new pair.
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id));
  const tokens = await issueTokens(c, user.id, user.username);
  await audit(c, { userId: user.id, action: "session.refresh" });
  return c.json(tokens);
});

router.post("/logout", requireAuth, async (c) => {
  const u = getUser(c);
  // Revoke ALL active sessions for this user (simple model). Could also accept a refresh_token to revoke just that device.
  await db.update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, u.sub), isNull(sessions.revokedAt)));
  await audit(c, { userId: u.sub, action: "user.logout" });
  return c.json({ ok: true });
});

router.get("/me", requireAuth, async (c) => {
  const u = getUser(c);
  const [user] = await db.select({
    id: users.id, email: users.email, username: users.username,
    emailVerifiedAt: users.emailVerifiedAt, createdAt: users.createdAt,
  }).from(users).where(eq(users.id, u.sub)).limit(1);
  if (!user) return c.json({ error: "not_found" }, 404);
  return c.json(user);
});

async function issueTokens(c: any, userId: string, username: string) {
  const accessToken = await signAccessToken({ sub: userId, username });
  const refreshToken = generateRefreshToken();
  const refreshHash = await hashRefreshToken(refreshToken);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000);

  await db.insert(sessions).values({
    userId,
    refreshTokenHash: refreshHash,
    userAgent: c.req.header("user-agent") ?? null,
    ipAddr: clientIp(c),
    expiresAt,
  });

  return {
    access_token: accessToken,
    access_token_expires_in: env.ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    refresh_token_expires_in: env.REFRESH_TOKEN_TTL_SECONDS,
  };
}

export default router;
