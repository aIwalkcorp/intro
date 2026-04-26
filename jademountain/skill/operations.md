# Edit Operation Reference

Source format: a single HTML document. Anchors are **plain substrings** of that
source (not regex, not CSS selectors). Frontend matches first occurrence and
asserts uniqueness.

## op: replace

Replace `anchor` with `with` exactly once. Anchor MUST be unique.

```json
{ "op": "replace", "anchor": "Day 2・攻頂", "with": "Day 2・玉山西峰" }
```

Frontend pseudocode:
```js
if (source.split(edit.anchor).length !== 2) reject(edit, "non-unique anchor");
source = source.replace(edit.anchor, edit.with);
```

## op: insert_after / insert_before

Insert `content` immediately after/before `anchor`. Anchor MUST be unique.

```json
{
  "op": "insert_after",
  "anchor": "<button class=\"day-btn\" data-day=\"d2\"",
  "content": "<button class=\"day-btn\" data-day=\"d3\" onclick=\"switchDayTab('d3')\"><span class=\"dlbl\">4/20 MON</span><span class=\"dname\">Day 3・下山</span></button>"
}
```

Use for: adding rows to schedules, adding day tabs, adding qlinks.

## op: delete_block

Delete everything from `start_anchor` (inclusive) to `end_anchor` (inclusive).
Both must be unique. `end_anchor` must appear AFTER `start_anchor` in source.

```json
{
  "op": "delete_block",
  "start_anchor": "<!-- ================= Day 0 ================= -->",
  "end_anchor": "<!-- ================= Day 1 ================= -->"
}
```

Use sparingly. Prefer `replace` with surgical anchors when possible.

## Anchor disambiguation patterns

When the obvious anchor is not unique, expand outward until it is:

| Risky anchor | Expanded anchor |
|---|---|
| `15:00` | `<div class="tl-t">15:00</div><div class="tl-p">排雲山莊` |
| `3 人` | `總額 $1,500・定金 $1,000（已付）` containing line; or `通舖 × 3 人` |
| `4/18` | `<span class="dlbl">4/18 SAT</span>` |
| `Day 1` | `Day 1 — 4/18（六）塔塔加 → 排雲山莊` |

Rule: include enough surrounding HTML (tag + attribute) to guarantee one match.
If you can't find a unique anchor in <300 chars, return `edits: []` and put the
problem in `warnings`.

## Date propagation rules

When the trip's start date changes:

1. Find all date occurrences. Common formats in this template:
   - `4/17`, `4/18`, `4/19` (slash, no year)
   - `2026/04/17` (full)
   - `4/17（五）` (with weekday in parentheses)
   - `<span class="dlbl">4/17 FRI</span>` (weekday English)
   - `<title>玉山主峰北峰登山計劃書 2026/04/17–19</title>` (range in title)

2. For each, recompute weekday using the user-provided new start date.
   Weekdays in zh: 一二三四五六日 (Mon–Sun); en: MON TUE WED THU FRI SAT SUN.

3. Emit one `replace` per occurrence. Group adjacent dates if anchors overlap.

4. Verify the new date arithmetic by listing all replacements in `summary_zh`.

## Party-size propagation

`3 人` appears in:
- `房型：通舖 × 3 人`
- `通舖・3 人・總額`
- `<div class="sub">2026/04/18–19 ｜ 2天1夜 ｜ 3人</div>`

When changing, also recompute total accommodation cost if present (price × headcount logic) — but only if you can verify the per-head price. Otherwise emit a warning: `"請手動確認新的住宿總額"`.

## Phone number policy

If user says "改聯絡人為 0912-345-678":
→ replace ALL `0911-210-072` and `tel:0911210072` occurrences with the new number, both formatted and tel: forms.

If user says "改聯絡人":
→ no edits. `summary_zh: "新聯絡人手機號碼是？"`.

Never alter `tel:112` or `tel:119` (international/local emergency).

## Anti-patterns (do NOT do)

- ❌ Anchor that is just punctuation or whitespace.
- ❌ `op: replace` where `with` is the entire HTML.
- ❌ Emitting more than 30 edits per response (split into a follow-up).
- ❌ Touching `<script>` blocks containing `function`, `const`, `let`, `var`
     declarations except for top-level data literals you can prove safe.
- ❌ Modifying CSS variables (`--bdr-2`, `--txtL`, etc.) without explicit ask.
