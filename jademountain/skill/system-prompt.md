# Trailforge Customizer — System Prompt (assembled)

This is the prompt your backend sends to the Anthropic API. Concatenate
`SKILL.md` + `operations.md` + each `examples/*.json`. Cache the whole bundle
with `cache_control: { type: "ephemeral" }` (5-min TTL) — the source HTML and
user request go in the user turn, NOT the cache.

## Recommended request shape (Haiku 4.5)

```javascript
const resp = await anthropic.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 2048,
  system: [
    { type: "text", text: SKILL_MD,        cache_control: { type: "ephemeral" } },
    { type: "text", text: OPERATIONS_MD,   cache_control: { type: "ephemeral" } },
    { type: "text", text: EXAMPLES_BUNDLE, cache_control: { type: "ephemeral" } }
  ],
  messages: [{
    role: "user",
    content: [
      { type: "text", text: `<source>\n${currentHtml}\n</source>\n\n<request>\n${userRequest}\n</request>` }
    ]
  }]
});
```

The HTML is in the user turn (not cached) because each plan is unique. The
skill bundle (SKILL.md + operations.md + examples) IS cached — that's where
your savings come from.

## Cost per request (after first)

With 50K html-input + 5K skill-system (cached) + 3K output:

| Model | First call | Cached call |
|---|---|---|
| Haiku 4.5 | ~$0.07 | ~$0.06 |
| Sonnet 4.6 | ~$0.21 | ~$0.18 |

(System bundle is small; the HTML dominates. Cache savings are modest because
the HTML is the bulk and isn't cached. If you cache the HTML for a single
session of multiple turns, savings climb to ~50%.)

## Validation pipeline (frontend)

```js
// 1. Parse Claude response
const out = JSON.parse(claudeText);

// 2. Verify each anchor
for (const e of out.edits) {
  if (e.op === "replace" || e.op === "insert_after" || e.op === "insert_before") {
    if (sourceHtml.split(e.anchor).length !== 2) {
      throw new Error(`anchor not unique: ${e.anchor.slice(0, 60)}`);
    }
  }
  if (e.op === "delete_block") {
    if (sourceHtml.split(e.start_anchor).length !== 2) throw ...;
    if (sourceHtml.split(e.end_anchor).length !== 2) throw ...;
    if (sourceHtml.indexOf(e.end_anchor) <= sourceHtml.indexOf(e.start_anchor)) throw ...;
  }
}

// 3. Apply in order
let working = sourceHtml;
for (const e of out.edits) {
  if (e.op === "replace") working = working.replace(e.anchor, e.with);
  else if (e.op === "insert_after") working = working.replace(e.anchor, e.anchor + e.content);
  else if (e.op === "insert_before") working = working.replace(e.anchor, e.content + e.anchor);
  else if (e.op === "delete_block") {
    const a = working.indexOf(e.start_anchor);
    const b = working.indexOf(e.end_anchor) + e.end_anchor.length;
    working = working.slice(0, a) + working.slice(b);
  }
}

// 4. Show diff to user; on accept, save to localStorage as override
```

## Rate-limit / abuse hints (for the proxy worker)

- Cap source size: reject if `currentHtml.length > 200_000`.
- Cap user prompt: reject if `userRequest.length > 2000`.
- Per-IP daily cap: 50 requests is generous; tune from logs.
- Reject if request matches `/(jailbreak|ignore previous|system prompt)/i`.
