import { Hono } from "hono";
import { db } from "../db/client";
import { aiUsage } from "../db/schema";
import { requireAuth, getUser } from "../auth/middleware";
import { SKILL_BUNDLE } from "../skill-bundle";
import { env } from "../lib/env";
import { log } from "../lib/logger";

const PHASES = new Set(["phase1_meta", "phase2_day", "phase3_extras", "done"]);
const MAX_USER_MESSAGE = 2000;
const MAX_PLAN_BYTES = 64 * 1024;

const router = new Hono();

router.post("/", requireAuth, async (c) => {
  if (!env.ANTHROPIC_API_KEY) return c.json({ error: "server_not_configured" }, 503);

  const u = getUser(c);

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
  const model = env.TRAILFORGE_MODEL;

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: [{ type: "text", text: SKILL_BUNDLE, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: userTurn }] }],
    }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text();
    log.error("upstream_error", { status: upstream.status, detail: detail.slice(0, 500) });
    return c.json({ error: "upstream_error", status: upstream.status }, 502);
  }

  const upstreamJson: any = await upstream.json();
  const usage = upstreamJson?.usage ?? {};

  // Log usage even if parse later fails — we still got billed.
  void logUsage(u.sub, model, usage);

  const text: string = upstreamJson?.content?.[0]?.text ?? "";
  const stripped = text.replace(/^\s*```(?:json)?\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "").trim();

  let parsed: any;
  try { parsed = JSON.parse(stripped); }
  catch {
    log.error("model_returned_non_json", { preview: text.slice(0, 200) });
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
    usage,
  });
});

async function logUsage(userId: string, model: string, usage: any): Promise<void> {
  const inputTokens          = Number(usage?.input_tokens ?? 0)             | 0;
  const outputTokens         = Number(usage?.output_tokens ?? 0)            | 0;
  const cacheReadTokens      = Number(usage?.cache_read_input_tokens ?? 0)  | 0;
  const cacheCreationTokens  = Number(usage?.cache_creation_input_tokens ?? 0) | 0;

  // Cache reads cost less (~10% of input price), but we keep math simple here:
  // bill all input-equivalent tokens at PRICE_INPUT_PER_MTOK, output at PRICE_OUTPUT_PER_MTOK.
  // Adjust later if cost reporting needs more precision.
  const inEq = inputTokens + cacheCreationTokens + Math.ceil(cacheReadTokens * 0.1);
  const cost = (inEq * env.PRICE_INPUT_PER_MTOK + outputTokens * env.PRICE_OUTPUT_PER_MTOK) / 1_000_000;

  try {
    await db.insert(aiUsage).values({
      userId, endpoint: "customize", model,
      inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
      costUsd: cost.toFixed(6),
    });
  } catch (e) {
    log.error("ai_usage_insert_failed", { error: String(e) });
  }
}

export default router;
