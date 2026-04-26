# Conversation State Machine

```
                  ┌────────────┐
   start ───────► │ phase1_meta│ ──── user fills meta + emergency_default
                  └─────┬──────┘
                        │
                        ▼ (next_day_index = 0)
                  ┌────────────┐
                  │ phase2_day │ ◄──── repeats per day
                  │  index = N │       (each Day: label / schedule /
                  └─────┬──────┘        key_times / retreat)
                        │
                        ▼ (when N reaches the last day)
                  ┌────────────┐
                  │phase3_extras│ ──── optional sub-interviews:
                  └─────┬──────┘       住宿 / emergency override / quick_links
                        │
                        ▼ (user says skip OR all extras done)
                  ┌────────────┐
                  │    done    │ ──── final summary, no more patches
                  └────────────┘
```

## Frontend responsibility

- Keep `plan_state`, `phase`, `day_index` in localStorage (key:
  `jm_customizer_session_v1`).
- After each Claude reply, apply patch, persist, send next user message with
  full state attached.
- Show progress chip: `Phase 1 / 4` → `Day 1 / 3` → `Extras` → `Done`.

## Skill responsibility (this file)

- Read `phase` + `day_index` to know what to ask.
- Never advance phase implicitly; always set `next_phase` and (if relevant)
  `next_day_index` in the response.
- If user types something that doesn't fit current phase ("我想改 Day 0"
  while in `phase2_day` index 1), treat it as a phase rewind:
  - emit `next_phase: "phase2_day"`, `next_day_index: 0`
  - do NOT emit any patches that turn (let user re-edit Day 0 next turn)

## Idempotency

If user repeats the same answer, emit `patch: []` and acknowledge. Don't
re-write fields that are already correct. The frontend's diff highlight will
have nothing to flash.

## Recovery

If `plan_state` is empty (no days, no meta.title) **and** `phase` is anything
other than `phase1_meta`, treat as session restart: ignore the supplied phase,
return as if you were starting `phase1_meta`. Add a `warnings` entry:
`"Session state lost; restarting interview."`

## Ending

`done` is sticky: once reached, any further user message returns a small
acknowledgment + offer to "再修改 (re-edit)" which rewinds to whichever phase
the user names. If the user says "rebuild from scratch", clear the plan with
`{ "op": "replace", "path": "", "value": <empty seed> }` and rewind to phase1.
