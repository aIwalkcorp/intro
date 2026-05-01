import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
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
  // shift_start_date: when present, server loads plan and shifts ALL date fields
  // (meta.start/end/depart_date + days[].date) by the offset between current
  // meta.start_date and this value, then re-formats day labels.
  shift_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const router = new Hono();
router.use("*", requireAuth);

// ---- helpers ----
const WEEKDAY_EN = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
function shiftIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function fmtDateLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${m}/${day} ${WEEKDAY_EN[d.getUTCDay()]}`;
}

// GET /api/plans — list current user's plans (newest first)
// Includes meta.start_date / end_date pulled out of jsonb for cheap card rendering.
router.get("/", async (c) => {
  const u = getUser(c);
  const rows = await db.select({
    id: plans.id,
    title: plans.title,
    createdAt: plans.createdAt,
    updatedAt: plans.updatedAt,
    startDate: sql<string | null>`${plans.data}->'meta'->>'start_date'`,
    endDate:   sql<string | null>`${plans.data}->'meta'->>'end_date'`,
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

// PATCH /api/plans/:id — update title, full data, or shift all dates by offset
router.patch("/:id", async (c) => {
  const u = getUser(c);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

  const update: Record<string, unknown> = { updatedAt: new Date() };

  if (parsed.data.shift_start_date) {
    // Load existing plan to compute offset + apply shift in-place.
    const [existing] = await db.select().from(plans)
      .where(and(eq(plans.id, id), eq(plans.userId, u.sub))).limit(1);
    if (!existing) return c.json({ error: "not_found" }, 404);
    const data: any = JSON.parse(JSON.stringify(existing.data));    // deep clone
    const oldStart = data?.meta?.start_date;
    if (!oldStart) return c.json({ error: "plan_has_no_start_date" }, 400);
    const offset = Math.round(
      (new Date(parsed.data.shift_start_date + "T00:00:00Z").getTime()
       - new Date(oldStart + "T00:00:00Z").getTime()) / 86400000
    );
    if (offset !== 0) {
      if (data.meta.start_date)  data.meta.start_date  = shiftIso(data.meta.start_date,  offset);
      if (data.meta.end_date)    data.meta.end_date    = shiftIso(data.meta.end_date,    offset);
      if (data.meta.depart_date) data.meta.depart_date = shiftIso(data.meta.depart_date, offset);
      if (Array.isArray(data.days)) {
        for (const day of data.days) {
          if (day.date) {
            day.date = shiftIso(day.date, offset);
            if (day.date_label) day.date_label = fmtDateLabel(day.date);
          }
        }
      }
    }
    update.data = data;
  }

  if (parsed.data.title !== undefined) update.title = parsed.data.title;
  if (parsed.data.data !== undefined)  update.data  = parsed.data.data;

  if (Object.keys(update).length === 1) return c.json({ error: "no_changes" }, 400);

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
