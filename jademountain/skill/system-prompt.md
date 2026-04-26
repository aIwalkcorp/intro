# Trailforge Customizer — System Prompt (assembly + cost)

## Building the prompt

Concatenate (in order):
1. `SKILL.md`
2. `operations.md`
3. `state-machine.md`
4. All `examples/*.json` (joined with newlines)

Cache the bundle with `cache_control: { type: "ephemeral" }` (5-min TTL). The
plan_state and user message go in the user turn — NOT cached, since they
change every turn.

## Recommended request shape (Haiku 4.5)

```javascript
const resp = await anthropic.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 1024,
  system: [
    { type: "text", text: SKILL_BUNDLE, cache_control: { type: "ephemeral" } }
  ],
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            plan_state,
            phase,
            day_index,
            user_message
          })
        }
      ]
    }
  ]
});
```

## Cost per turn

Bundle ~10K input tokens (cached after first call), plan_state ~1K tokens,
user_message ~50 tokens, output ~500 tokens.

| Model | First turn | Cached subsequent turns |
|---|---|---|
| Haiku 4.5 | ~$0.014 | ~$0.005 |
| Sonnet 4.6 | ~$0.040 | ~$0.022 |

A typical full interview (10 turns) on Haiku 4.5: **~$0.06 ≈ NT$1.9**.

A user that revises 3 sections after `done`: another 6 turns ≈ NT$1.

→ Easily fits the NT$30-60 / customisation session budget with margin for
many edits.

## Rate-limit and validation (proxy)

```js
// Reject malformed input early
if (!body.plan_state || typeof body.plan_state !== 'object') return 400;
if (!['phase1_meta','phase2_day','phase3_extras','done'].includes(body.phase)) return 400;
if ((body.user_message || '').length > 2000) return 413;

// After Claude responds, validate JSON shape
const out = JSON.parse(claudeText);
if (!Array.isArray(out.patch)) throw new Error('bad output');
if (typeof out.assistant_message !== 'string') throw new Error('bad output');
if (!['phase1_meta','phase2_day','phase3_extras','done'].includes(out.next_phase)) throw new Error('bad output');

// Apply patches with try/catch in the browser
import { applyPatch } from 'fast-json-patch';
let nextState;
try {
  nextState = applyPatch(structuredClone(plan_state), out.patch, true).newDocument;
} catch (e) {
  // Surface to user: "Could not apply update; please rephrase."
  return showError(e);
}

// Persist + re-render
localStorage.setItem('jm_customizer_session_v1', JSON.stringify({
  plan_state: nextState, phase: out.next_phase, day_index: out.next_day_index
}));
TF.render(nextState);
```

## Why this design

- **JSON Patch over anchor edits**: paths are unique by RFC; no string-collision
  problem; trivially diffable for an "undo last turn" feature.
- **One question per turn (mostly)**: keeps each output small (<1K tokens) →
  saves on output cost, which is 5× input cost on Haiku.
- **plan_state in user turn, not cached**: each turn has a different state,
  so caching it is useless. The big stable artifact (the skill bundle) IS
  cached, which is where the savings actually come from.
- **Quick replies**: reduce free-text answers, faster UX, tighter inputs.
- **next_phase explicit**: skill is stateless; frontend owns session.
