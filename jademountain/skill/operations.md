# JSON Patch Operations Reference

This skill emits **RFC 6902** JSON Patch arrays. The frontend applies them with
[`fast-json-patch`](https://github.com/Starcounter-Jack/JSON-Patch) (~5KB) then
calls `TF.render(plan)` to repaint.

## Allowed ops

| op | path examples | use |
|---|---|---|
| `replace` | `/meta/title`, `/days/0/schedule/2/note` | scalar field updates |
| `add` (append) | `/days/-`, `/days/0/schedule/-`, `/days/0/key_times/-` | append to arrays via `-` token |
| `add` (insert) | `/days/0/schedule/2` | insert at index |
| `remove` | `/days/0/schedule/3` | drop array item or scalar field |
| `move` | `from: /days/0/schedule/3, path: /days/0/schedule/0` | reorder |
| `test` | `/meta/lang` value `"zh-TW"` | (rare) precondition guard |

`copy` is supported by RFC 6902 but **avoid** — it makes patches harder to audit.

## Plan-shape paths (target schema)

```
/meta/title              string
/meta/start_date         "YYYY-MM-DD"
/meta/end_date           "YYYY-MM-DD"
/meta/depart_date        "YYYY-MM-DD" | null
/meta/party_size         integer
/meta/party_label        string
/meta/lang               "zh-TW" | "en" | "bilingual"
/meta/theme_color        "#RRGGBB"
/meta/activity_type      "hiking" | "cycling" | "running" | "custom"
/meta/page_title         string
/meta/short_name         string

/emergency_default/standby/name        string
/emergency_default/standby/phone       "0911-210-072"
/emergency_default/standby/phone_tel   "0911210072"
/emergency_default/messenger_url       string | null
/emergency_default/include_112         boolean
/emergency_default/include_119         boolean
/emergency_default/local_emergency_label  string

/days/N/id                       "d0" | "d1" | ...
/days/N/date                     "YYYY-MM-DD"
/days/N/date_label               "4/18 SAT"
/days/N/label                    "Day 1・上山"
/days/N/tag                      "d1" | "d2" | "d2a" | "d2b" | null
/days/N/tag_text                 "8.5 KM ｜ +923 M" | null
/days/N/tag_color_override       css-gradient string | null
/days/N/section_title            "Day 1 — 4/18（六）..."
/days/N/emergency_card_title     "🚨 Day 1・上山關鍵時間"
/days/N/key_times/M/label        string
/days/N/key_times/M/value        "HH:MM" or "HH–HH"
/days/N/key_times/M/note         string | null
/days/N/quick_links/M/icon       emoji
/days/N/quick_links/M/text       string
/days/N/quick_links/M/href       url
/days/N/quick_links/M/external   boolean
/days/N/schedule/M/time          "HH:MM"
/days/N/schedule/M/title         string
/days/N/schedule/M/note          string | null
/days/N/schedule/M/note_html     html string | null  (only if note has links)
/days/N/schedule/M/elevation     "2,610m" | null
/days/N/schedule/M/highlight     boolean
/days/N/schedule/M/decision      boolean
/days/N/schedule/M/decision_buttons  array (rare; alternate routes)
/days/N/routes/M/...             multi-route variants (Day 2A/2B style)
/days/N/details/M/icon           emoji
/days/N/details/M/title          string
/days/N/details/M/rows_html      array of html strings
/days/N/retreat                  object | null
/days/N/retreat/title            string
/days/N/retreat/title_color      "#hex"
/days/N/retreat/title_border     "#hex"
/days/N/retreat/items_html       array of html strings
/days/N/retreat/raw_html         boolean
```

## Anti-patterns

- ❌ `replace` on a path that doesn't exist yet → use `add`.
- ❌ Patching `/days/-/schedule/-` (double `-`). Append day, then in a later
     turn append schedule entries — keep ops one-level-at-a-time.
- ❌ Setting a phone number you didn't get from the user. Use `null` and ask.
- ❌ Building a fully-formed `routes` array unless the user explicitly says
     they want alternate routes (advanced feature, defer to phase3 extras).

## Small-patch idiom

Prefer many small ops over one giant `replace`. Examples:

Good:
```json
[
  { "op": "replace", "path": "/meta/title", "value": "玉山主峰" },
  { "op": "replace", "path": "/meta/start_date", "value": "2026-04-18" },
  { "op": "replace", "path": "/meta/end_date", "value": "2026-04-19" },
  { "op": "replace", "path": "/meta/party_size", "value": 3 }
]
```

Bad:
```json
[
  { "op": "replace", "path": "/meta", "value": { "title": "...", "start_date": "...", ... } }
]
```
(Replaces the whole meta object — collapses any pre-existing fields.)

## Pre-condition with `test`

If you must guard against stale state (e.g. user came back to revise day 0
after day 2 was added), prepend a `test` op:

```json
[
  { "op": "test", "path": "/days/0/id", "value": "d0" },
  { "op": "replace", "path": "/days/0/label", "value": "Day 0・出發" }
]
```

Frontend treats a failed `test` as the whole patch rejected.
