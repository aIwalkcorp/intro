import { Hono } from "hono";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/client";
import { aiUsage } from "../db/schema";
import { requireAuth, getUser } from "../auth/middleware";

const router = new Hono();
router.use("*", requireAuth);

router.get("/", async (c) => {
  const u = getUser(c);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [totals] = await db.select({
    calls:        sql<number>`count(*)::int`,
    inputTokens:  sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::int`,
    outputTokens: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::int`,
    cacheReads:   sql<number>`coalesce(sum(${aiUsage.cacheReadTokens}), 0)::int`,
    costUsd:      sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)::text`,
  }).from(aiUsage).where(and(
    eq(aiUsage.userId, u.sub),
    gte(aiUsage.createdAt, monthStart),
  ));

  const recent = await db.select({
    endpoint: aiUsage.endpoint,
    model: aiUsage.model,
    inputTokens: aiUsage.inputTokens,
    outputTokens: aiUsage.outputTokens,
    costUsd: aiUsage.costUsd,
    createdAt: aiUsage.createdAt,
  }).from(aiUsage)
    .where(eq(aiUsage.userId, u.sub))
    .orderBy(sql`${aiUsage.createdAt} desc`)
    .limit(20);

  return c.json({
    period: { start: monthStart.toISOString(), now: new Date().toISOString() },
    totals,
    recent: recent.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  });
});

export default router;
