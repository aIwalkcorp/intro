import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { plans } from "../db/schema";
import { requireAuth, getUser } from "../auth/middleware";
import { audit } from "../lib/audit";

const CreateSchema = z.object({
  title: z.string().min(1).max(200),
  data: z.record(z.any()),
});

const PatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  data: z.record(z.any()).optional(),
});

const router = new Hono();
router.use("*", requireAuth);

// GET /api/plans — list current user's plans (newest first)
router.get("/", async (c) => {
  const u = getUser(c);
  const rows = await db.select({
    id: plans.id,
    title: plans.title,
    createdAt: plans.createdAt,
    updatedAt: plans.updatedAt,
  }).from(plans).where(eq(plans.userId, u.sub)).orderBy(desc(plans.updatedAt));
  return c.json({ plans: rows });
});

// POST /api/plans — create a new plan
router.post("/", async (c) => {
  const u = getUser(c);
  const body = await c.req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_input", details: parsed.error.flatten() }, 400);

  const [row] = await db.insert(plans).values({
    userId: u.sub,
    title: parsed.data.title,
    data: parsed.data.data,
  }).returning();
  if (!row) return c.json({ error: "create_failed" }, 500);
  await audit(c, { userId: u.sub, action: "plan.create", resourceType: "plan", resourceId: row.id });
  return c.json(row, 201);
});

// GET /api/plans/:id — fetch one plan owned by current user
router.get("/:id", async (c) => {
  const u = getUser(c);
  const id = c.req.param("id");
  const [row] = await db.select().from(plans)
    .where(and(eq(plans.id, id), eq(plans.userId, u.sub))).limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(row);
});

// PATCH /api/plans/:id — update title and/or data
router.patch("/:id", async (c) => {
  const u = getUser(c);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400);
  if (!parsed.data.title && !parsed.data.data) return c.json({ error: "no_changes" }, 400);

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.title !== undefined) update.title = parsed.data.title;
  if (parsed.data.data !== undefined) update.data = parsed.data.data;

  const [row] = await db.update(plans).set(update)
    .where(and(eq(plans.id, id), eq(plans.userId, u.sub)))
    .returning();
  if (!row) return c.json({ error: "not_found" }, 404);
  await audit(c, { userId: u.sub, action: "plan.update", resourceType: "plan", resourceId: row.id });
  return c.json(row);
});

// DELETE /api/plans/:id
router.delete("/:id", async (c) => {
  const u = getUser(c);
  const id = c.req.param("id");
  const [row] = await db.delete(plans)
    .where(and(eq(plans.id, id), eq(plans.userId, u.sub)))
    .returning({ id: plans.id });
  if (!row) return c.json({ error: "not_found" }, 404);
  await audit(c, { userId: u.sub, action: "plan.delete", resourceType: "plan", resourceId: id });
  return c.json({ ok: true });
});

export default router;
