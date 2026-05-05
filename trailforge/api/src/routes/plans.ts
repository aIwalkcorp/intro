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
  // set_duration: trip length in days (1..30). Server adjusts end_date and
  // grows/shrinks the days[] array. Days BEFORE start_date (depart days) are
  // preserved untouched.
  set_duration: z.number().int().min(1).max(30).optional(),
  // set_nights: number of overnight stays during the trip. Decoupled from
  // set_duration so a user can express e.g. "2 hike days, 2 nights" — meaning
  // the night before Day 1 (lodging at trailhead) plus the night between
  // Day 1 and Day 2. Concretely: when set_nights = set_duration → ensure a
  // pre-departure day (date = start_date - 1, "Day 0 / 出發"); when set_nights
  // = set_duration - 1 → remove any pre-departure day. Other values are
  // accepted but not currently auto-shaped beyond ±1 day either side.
  set_nights: z.number().int().min(0).max(30).optional(),
  // set_party_size / set_party_label: trip head-count, mirrored to data.meta
  set_party_size: z.number().int().min(1).max(99).optional(),
  set_party_label: z.string().min(1).max(40).optional(),
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
    startDate:  sql<string | null>`${plans.data}->'meta'->>'start_date'`,
    endDate:    sql<string | null>`${plans.data}->'meta'->>'end_date'`,
    departDate: sql<string | null>`${plans.data}->'meta'->>'depart_date'`,
    partySize:  sql<number | null>`(${plans.data}->'meta'->>'party_size')::int`,
    partyLabel: sql<string | null>`${plans.data}->'meta'->>'party_label'`,
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

  // Decide whether to load+mutate existing data. We do so when:
  //  - dates are being shifted/resized
  //  - title is being changed (we mirror it into data.meta.title so the
  //    rendered schedule heading stays in sync with the dashboard rename)
  // If a full `data` is supplied, that takes precedence at the end.
  const needsExisting =
    parsed.data.shift_start_date !== undefined ||
    parsed.data.set_duration !== undefined ||
    parsed.data.set_nights !== undefined ||
    parsed.data.set_party_size !== undefined ||
    parsed.data.set_party_label !== undefined ||
    parsed.data.title !== undefined;

  let working: any = null;
  if (needsExisting) {
    const [existing] = await db.select().from(plans)
      .where(and(eq(plans.id, id), eq(plans.userId, u.sub))).limit(1);
    if (!existing) return c.json({ error: "not_found" }, 404);
    working = JSON.parse(JSON.stringify(existing.data));    // deep clone
  }

  if (
    parsed.data.shift_start_date ||
    parsed.data.set_duration !== undefined ||
    parsed.data.set_nights   !== undefined
  ) {
    const data = working;
    const oldStart = data?.meta?.start_date;
    if (!oldStart) return c.json({ error: "plan_has_no_start_date" }, 400);

    // Step 1: shift everything by offset if shift_start_date is given
    if (parsed.data.shift_start_date) {
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
    }

    // Step 2: resize days[] if set_duration is given.
    // Convention: depart days (date < start_date) are preserved untouched.
    // The "trip" is days where date >= start_date; we want exactly N such days.
    if (parsed.data.set_duration !== undefined) {
      const start = data.meta.start_date as string;
      const targetN = parsed.data.set_duration;
      const newEnd = shiftIso(start, targetN - 1);
      data.meta.end_date = newEnd;
      if (!Array.isArray(data.days)) data.days = [];
      const departDays: any[] = [];
      const tripDays: any[] = [];
      for (const d of data.days) {
        if (d.date && d.date < start) departDays.push(d);
        else tripDays.push(d);
      }
      // Sort tripDays by date so resize is deterministic
      tripDays.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
      let resized = tripDays.slice(0, targetN);
      while (resized.length < targetN) {
        const idx = resized.length;          // 0-based index into trip days
        const dayDate = shiftIso(start, idx);
        const num = idx + 1;
        // Clone schema/styling from the LAST existing trip day if any, else minimal
        const template = resized[resized.length - 1] || tripDays[tripDays.length - 1] || {};
        const clone: any = template ? JSON.parse(JSON.stringify(template)) : {};
        // wipe content so user can fill in fresh
        clone.id = "d" + num;
        clone.date = dayDate;
        clone.date_label = fmtDateLabel(dayDate);
        clone.label = `Day ${num}`;
        clone.tag = null;
        clone.tag_text = null;
        clone.summary = null;
        clone.stats = null;
        clone.section_title = `Day ${num} — ${dayDate}`;
        clone.emergency_card_title = null;
        clone.key_times = [];
        clone.quick_links = [];
        clone.schedule = [];
        clone.details = [];
        clone.routes = undefined;
        clone.retreat = null;
        resized.push(clone);
      }
      data.days = [...departDays, ...resized];
    }

    // Step 3: handle set_nights — adds/removes a pre-departure day so the
    // user can express e.g. 2D2N (玉山-style: trail-head sleep + summit night).
    if (parsed.data.set_nights !== undefined) {
      const start = data.meta.start_date as string;
      const tripDayCount = (data.days || []).filter(
        (d: any) => d.date && d.date >= start
      ).length;
      const wantPreDay = parsed.data.set_nights >= tripDayCount;     // ≥ duration → need depart day
      const departDate = shiftIso(start, -1);
      const departIdx = (data.days || []).findIndex(
        (d: any) => d.date && d.date < start
      );
      if (wantPreDay && departIdx === -1) {
        const departDay = {
          id: "d0",
          date: departDate,
          date_label: fmtDateLabel(departDate),
          label: "Day 0・出發",
          tag: null,
          tag_text: "出發日",
          section_title: `Day 0 — ${departDate}（出發）`,
          emergency_card_title: "🚨 Day 0・出發關鍵時間",
          key_times: [],
          quick_links: [],
          schedule: [],
          details: [],
          retreat: null,
        };
        data.days = [departDay, ...(data.days || [])];
        data.meta.depart_date = departDate;
      } else if (!wantPreDay && departIdx !== -1) {
        data.days = (data.days || []).filter(
          (d: any) => !(d.date && d.date < start)
        );
        delete data.meta.depart_date;
      }
    }
  }

  // Mirror title / party fields into data.meta so the rendered header stays
  // in sync with dashboard edits. Done after shift/resize so any nested
  // mutation sees the correct working object.
  if (working) {
    if (!working.meta) working.meta = {};
    if (parsed.data.title !== undefined) working.meta.title = parsed.data.title;
    if (parsed.data.set_party_size !== undefined) {
      working.meta.party_size = parsed.data.set_party_size;
      // auto-sync label if it's empty or already in plain "N人" format and no label override is supplied
      if (parsed.data.set_party_label === undefined) {
        const cur = working.meta.party_label;
        if (!cur || /^\d+人$/.test(String(cur).trim())) {
          working.meta.party_label = `${parsed.data.set_party_size}人`;
        }
      }
    }
    if (parsed.data.set_party_label !== undefined) {
      working.meta.party_label = parsed.data.set_party_label;
    }
  }

  if (working) update.data = working;
  if (parsed.data.title !== undefined) update.title = parsed.data.title;
  // Explicit full-data update wins over mirrored mutations
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
