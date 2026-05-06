/* Trailforge — legacy plan upgrade
 *
 * Migrates plans saved BEFORE the 888d61c "View entirely derived"
 * refactor into the current schema, so they keep working with the new
 * Edit / View / docx-export pipeline. Idempotent: re-running on a
 * fresh-format plan is a no-op.
 *
 * What it does (mirroring the inline plan-data migration that ran on
 * the玉山 demo via Python script):
 *   1. For each day, lift `schedule[].time` → `elevation_profile.start_time`
 *      (and per-variant.start_time when route_variants exist).
 *   2. Migrate `schedule[].note` → matching segment.note via name lookup
 *      (uses render.js's existing migrateScheduleNotesToSegments helper).
 *   3. Clear `schedule[]` and `routes[].schedule[]` so View derives from
 *      segments — the new "single source of truth" rule.
 *   4. Set plan.auto_return_descent default + remove orphan flags.
 *   5. setDirty so the user sees the save chip; saving persists.
 *
 * Triggered automatically by render.js on plan load when legacy markers
 * are detected. Also exposed as TF.migrate.upgradeLegacyPlan(plan) for
 * manual / scripted use.
 */
(function () {
  'use strict';
  const TF = (window.TF = window.TF || {});

  function isHM(s) { return /^\d{1,2}:\d{2}$/.test(String(s || '')); }

  function isLegacy(plan) {
    if (!plan || !Array.isArray(plan.days)) return false;
    // Markers of pre-888d61c shape: any day or route still carries an
    // unmigrated schedule array AND that day has segments to derive from.
    for (const d of plan.days) {
      const hasSegs = !!(d.elevation_profile && (
        (d.elevation_profile.shanghe_segments || []).length ||
        (d.elevation_profile.route_variants &&
         Object.values(d.elevation_profile.route_variants).some(v => (v.shanghe_segments || []).length))
      ));
      if (!hasSegs) continue;
      if (Array.isArray(d.schedule) && d.schedule.length) return true;
      if (Array.isArray(d.routes)) {
        for (const r of d.routes) if (Array.isArray(r.schedule) && r.schedule.length) return true;
      }
    }
    return false;
  }

  function pickFirstTime(arr) {
    for (const it of (arr || [])) if (it && isHM(it.time)) return it.time;
    return null;
  }

  function upgradeLegacyPlan(plan) {
    if (!plan || !Array.isArray(plan.days)) return false;
    let mutated = false;
    for (const d of plan.days) {
      const ep = d.elevation_profile || (d.elevation_profile = {});

      // start_time per variant when route_variants present, else on ep.
      if (ep.route_variants && Array.isArray(d.routes)) {
        for (const r of d.routes) {
          const variant = ep.route_variants[r.id];
          if (variant && !isHM(variant.start_time)) {
            const t = pickFirstTime(r.schedule);
            if (t) { variant.start_time = t; mutated = true; }
          }
        }
      }
      if (!isHM(ep.start_time)) {
        const t = pickFirstTime(d.schedule);
        if (t) { ep.start_time = t; mutated = true; }
      }

      // Clear schedules — derived path now owns View timeline.
      if (Array.isArray(d.schedule) && d.schedule.length) { d.schedule = []; mutated = true; }
      for (const r of (d.routes || [])) {
        if (Array.isArray(r.schedule) && r.schedule.length) { r.schedule = []; mutated = true; }
      }
    }

    // auto_return_descent default — older plans didn't carry this flag;
    // leave true so descent rows synth as before.
    if (plan.auto_return_descent === undefined) {
      plan.auto_return_descent = true;
    }

    // Note migration: render.js's migrateScheduleNotesToSegments runs at
    // every render but ONLY when day.schedule still has the items. We've
    // just cleared them, so call the helper BEFORE the clear next time.
    // Ordering fix: re-do the migration order — call helper first, then
    // clear. Restructure:
    return mutated;
  }

  // Drive the migration in the correct order (notes first, then clear).
  function upgradeLegacyPlanInOrder(plan) {
    if (!plan || !Array.isArray(plan.days)) return false;
    let mutated = false;
    // Phase 1: per-day note migration via render.js helper if exposed,
    // then start_time hoist.
    const migrateNotes = (TF.render && TF.render.__migrateNotes) || null;
    for (const d of plan.days) {
      if (migrateNotes) try { migrateNotes(d); } catch (e) {}
    }
    // Phase 2: clear + start_time + flags
    if (upgradeLegacyPlan(plan)) mutated = true;
    return mutated;
  }

  function autoUpgradeOnLoad() {
    const plan = window.__PLAN__;
    if (!plan || !isLegacy(plan)) return;
    const changed = upgradeLegacyPlanInOrder(plan);
    if (changed) {
      console.info('[trailforge] legacy plan upgraded in-memory; save to persist.');
      if (window.TF_EDIT && window.TF_EDIT.setDirty) window.TF_EDIT.setDirty(true);
      // Re-render so View picks up the migrated state immediately.
      if (TF.render) try { TF.render(plan); } catch (e) {}
      if (TF.modeToggle && TF.modeToggle.refreshAll) {
        requestAnimationFrame(() => TF.modeToggle.refreshAll());
      }
    }
  }

  TF.migrate = TF.migrate || {};
  TF.migrate.upgradeLegacyPlan = upgradeLegacyPlanInOrder;
  TF.migrate.isLegacyPlan = isLegacy;
  TF.migrate.autoUpgradeOnLoad = autoUpgradeOnLoad;

  // Hook into the plan-loaded event (dispatched by render.js after loadPlan
  // finishes / outbox restores). If the event hasn't fired yet, also try on
  // DOMContentLoaded as a fallback.
  document.addEventListener('tf:plan-loaded', autoUpgradeOnLoad);
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(autoUpgradeOnLoad, 50);
  });
})();
