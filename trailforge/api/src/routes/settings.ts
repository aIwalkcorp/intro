import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { userSettings } from "../db/schema";
import { requireAuth, getUser } from "../auth/middleware";

const MODULE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const KEY_RE    = /^[a-zA-Z0-9_.-]{1,64}$/;
const PutSchema = z.object({ value: z.unknown() });
const MAX_VALUE_BYTES = 16 * 1024;

const router = new Hono();
router.use("*", requireAuth);

router.get("/:module", async (c) => {
  const mod = c.req.param("module");
  if (!MODULE_RE.test(mod)) return c.json({ error: "invalid_module" }, 400);
  const u = getUser(c);

  const rows = await db.select({ key: userSettings.key, value: userSettings.value, updatedAt: userSettings.updatedAt })
    .from(userSettings)
    .where(and(eq(userSettings.userId, u.sub), eq(userSettings.module, mod)));

  const out: Record<string, { value: unknown; updated_at: string }> = {};
  for (const r of rows) out[r.key] = { value: r.value, updated_at: r.updatedAt.toISOString() };
  return c.json({ module: mod, settings: out });
});

router.put("/:module/:key", async (c) => {
  const mod = c.req.param("module");
  const key = c.req.param("key");
  if (!MODULE_RE.test(mod)) return c.json({ error: "invalid_module" }, 400);
  if (!KEY_RE.test(key))    return c.json({ error: "invalid_key" }, 400);

  const body = await c.req.json().catch(() => null);
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

  const serialized = JSON.stringify(parsed.data.value);
  if (serialized.length > MAX_VALUE_BYTES) return c.json({ error: "value_too_large" }, 413);

  const u = getUser(c);
  const now = new Date();
  await db.insert(userSettings)
    .values({ userId: u.sub, module: mod, key, value: parsed.data.value as any, updatedAt: now })
    .onConflictDoUpdate({
      target: [userSettings.userId, userSettings.module, userSettings.key],
      set: { value: parsed.data.value as any, updatedAt: now },
    });

  return c.json({ ok: true, module: mod, key, updated_at: now.toISOString() });
});

router.delete("/:module/:key", async (c) => {
  const mod = c.req.param("module");
  const key = c.req.param("key");
  if (!MODULE_RE.test(mod)) return c.json({ error: "invalid_module" }, 400);
  if (!KEY_RE.test(key))    return c.json({ error: "invalid_key" }, 400);
  const u = getUser(c);

  await db.delete(userSettings).where(and(
    eq(userSettings.userId, u.sub),
    eq(userSettings.module, mod),
    eq(userSettings.key, key),
  ));
  return c.json({ ok: true });
});

export default router;
