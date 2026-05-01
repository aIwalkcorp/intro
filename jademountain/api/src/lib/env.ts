import { z } from "zod";

const Schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4100),

  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  TRAILFORGE_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:8000"),
  SKILL_DIR: z.string().optional(),

  DATABASE_URL: z.string().min(1, "DATABASE_URL required (Neon pooled URL)"),
  DATABASE_URL_UNPOOLED: z.string().optional(),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be >= 32 chars"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 60 * 60),

  PRICE_INPUT_PER_MTOK: z.coerce.number().nonnegative().default(1.0),
  PRICE_OUTPUT_PER_MTOK: z.coerce.number().nonnegative().default(5.0),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error("[env] invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const ALLOWED_ORIGINS = env.ALLOWED_ORIGINS
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
