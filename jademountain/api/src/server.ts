import { Hono } from "hono";
import { cors } from "hono/cors";
import { SKILL_BUNDLE } from "./skill-bundle";

const PHASES = new Set(["phase1_meta", "phase2_day", "phase3_extras", "done"]);
const MAX_USER_MESSAGE = 2000;
const MAX_PLAN_BYTES = 64 * 1024;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.TRAILFORGE_MODEL ?? "claude-haiku-4-5-20251001";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "https://aiwalkcorp.com,http://localhost:8000")
  .split(",").map((s) => s.trim()).filter(Boolean);

if (!ANTHROPIC_API_KEY) {
  console.warn("[trailforge-api] ANTHROPIC_API_KEY not set — /customize will 503");
}

const app = new Hono();

app.use("*", cors({
  origin: (origin) => (origin && ALLOWED_ORIGINS.includes(origin)) ? origin : ALLOWED_ORIGINS[0],
  allowMethods: ["POST", "GET", "OPTIONS"],
  allowHeaders: ["content-type"],
  maxAge: 86400,
}));

app.get("/healthz", (c) => c.json({
  ok: true,
  bundle_bytes: SKILL_BUNDLE.length,
  has_key: Boolean(ANTHROPIC_API_KEY),
  model: MODEL,
}));

app.post("/customize", async (c) => {
  if (!ANTHROPIC_API_KEY) return c.json({ error: "server_not_configured" }, 503);

  let body: any;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid_json" }, 400); }

  const { plan_state, phase, day_index, user_message } = body ?? {};
  if (!plan_state || typeof plan_state !== "object") return c.json({ error: "missing_plan_state" }, 400);
  if (!PHASES.has(phase)) return c.json({ error: "invalid_phase" }, 400);
  if (typeof user_message !== "string") return c.json({ error: "missing_user_message" }, 400);
  if (user_message.length > MAX_USER_MESSAGE) return c.json({ error: "user_message_too_long" }, 413);

  const planJson = JSON.stringify(plan_state);
  if (planJson.length > MAX_PLAN_BYTES) return c.json({ error: "plan_state_too_large" }, 413);

  const userTurn = JSON.stringify({ plan_state, phase, day_index, user_message });

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: [{ type: "text", text: SKILL_BUNDLE, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: userTurn }] }],
    }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text();
    console.error("[trailforge-api] upstream error", upstream.status, detail.slice(0, 500));
    return c.json({ error: "upstream_error", status: upstream.status }, 502);
  }

  const upstreamJson: any = await upstream.json();
  const text: string = upstreamJson?.content?.[0]?.text ?? "";

  // Haiku occasionally wraps JSON in ```json ... ``` despite instructions.
  // Strip a single fence pair if present, then try to parse.
  const stripped = text.replace(/^\s*```(?:json)?\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "").trim();

  let parsed: any;
  try { parsed = JSON.parse(stripped); }
  catch {
    console.error("[trailforge-api] non-JSON output:", text.slice(0, 500));
    return c.json({ error: "model_returned_non_json", raw: text.slice(0, 500) }, 502);
  }

  if (!Array.isArray(parsed.patch)) return c.json({ error: "bad_output_patch" }, 502);
  if (typeof parsed.assistant_message !== "string") return c.json({ error: "bad_output_message" }, 502);
  if (!PHASES.has(parsed.next_phase)) return c.json({ error: "bad_output_next_phase" }, 502);

  return c.json({
    patch: parsed.patch,
    assistant_message: parsed.assistant_message,
    quick_replies: Array.isArray(parsed.quick_replies) ? parsed.quick_replies : [],
    next_phase: parsed.next_phase,
    next_day_index: parsed.next_day_index ?? null,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    usage: upstreamJson?.usage ?? null,
  });
});

const PORT = Number(process.env.PORT ?? 4100);
export default { port: PORT, fetch: app.fetch };
console.log(`[trailforge-api] listening on :${PORT}`);
