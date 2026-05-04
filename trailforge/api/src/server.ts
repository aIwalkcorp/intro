import { Hono } from "hono";
import { cors } from "hono/cors";
import { SKILL_BUNDLE } from "./skill-bundle";
import { env, ALLOWED_ORIGINS } from "./lib/env";
import { log } from "./lib/logger";
import { pingDb } from "./db/client";
import authRouter from "./routes/auth";
import settingsRouter from "./routes/settings";
import usageRouter from "./routes/usage";
import customizeRouter from "./routes/customize";
import plansRouter from "./routes/plans";

if (!env.ANTHROPIC_API_KEY) {
  log.warn("anthropic_key_missing", { msg: "/customize will 503 until ANTHROPIC_API_KEY is set" });
}

const app = new Hono();

app.use("*", cors({
  origin: (origin) => (origin && ALLOWED_ORIGINS.includes(origin)) ? origin : ALLOWED_ORIGINS[0]!,
  allowMethods: ["POST", "GET", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["content-type", "authorization"],
  maxAge: 86400,
  credentials: false,
}));

app.use("*", async (c, next) => {
  const t0 = performance.now();
  await next();
  const ms = Math.round(performance.now() - t0);
  log.info("req", {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    ms,
  });
});

app.get("/healthz", async (c) => {
  const dbOk = await pingDb();
  return c.json({
    ok: dbOk,
    bundle_bytes: SKILL_BUNDLE.length,
    has_key: Boolean(env.ANTHROPIC_API_KEY),
    model: env.TRAILFORGE_MODEL,
    db: dbOk ? "ok" : "down",
    env: env.NODE_ENV,
  }, dbOk ? 200 : 503);
});

app.route("/auth", authRouter);
app.route("/api/settings", settingsRouter);
app.route("/api/usage", usageRouter);
app.route("/customize", customizeRouter);
app.route("/api/plans", plansRouter);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  log.error("unhandled", { error: String(err), stack: err.stack });
  return c.json({ error: "internal" }, 500);
});

const PORT = env.PORT;
log.info("listening", { port: PORT, env: env.NODE_ENV, model: env.TRAILFORGE_MODEL });
export default { port: PORT, fetch: app.fetch };
