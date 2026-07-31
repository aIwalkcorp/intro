# Trailforge Scrapers

Playwright-driven scrapers for hiking-related data.

> Note: `microsoft/playwright-cli` is archived. This package uses the modern
> `playwright` npm package, which ships CLI utilities (`codegen`, `install`,
> `test`) inside the same package — no separate CLI install needed.

## Setup

```bash
cd scrapers
npm install                  # already done — node_modules present
npm run install-browsers     # downloads Chromium (~290 MB, one-off)
```

WSL note: if a browser launch fails with missing libs, run
`sudo npx playwright install-deps chromium` once.

## Running scrapers

```bash
# Windy weather snapshot (default coords = 玉山主峰)
npm run windy
npm run windy -- 23.5 121.4
HEADLESS=0 npm run windy        # watch the browser

# 健行筆記 keyword search
npm run hiking-notes -- 玉山
npm run hiking-notes -- 奇萊南華 5
```

Output lands in `out/`:
- `windy-<lat>-<lon>.png`  — screenshot of the map UI
- `windy-<lat>-<lon>.json` — wind / temp / humidity scraped from the side panel
- `hiking-notes-<keyword>.json` — list of `{ title, href, excerpt }`

## Recording new scrapers

```bash
npx playwright codegen https://example.com
```

The recorder opens a browser; you click around, it generates the
Playwright code as you go. Copy the generated snippet into `src/` and
add a row to `package.json` scripts.

## Layout

```
scrapers/
  package.json
  tsconfig.json
  src/
    lib/browser.ts        # shared launcher (UA, viewport, locale)
    windy.ts              # Windy snapshot scraper
    hiking-notes.ts       # 健行筆記 keyword scraper
  out/                    # gitignored; scraper outputs
```

## Adding a new site

1. `cp src/hiking-notes.ts src/<newsite>.ts` and adapt selectors.
2. Use `openBrowser()` from `lib/browser.ts` — it gives you a Chromium
   page with realistic UA + zh-TW locale + Asia/Taipei timezone, which
   most Taiwan sites need to serve the right content.
3. Add an npm script row pointing at the file.
4. Keep raw outputs in `out/` so they're easy to inspect; commit
   summarised JSON elsewhere if it becomes structured data.

## Respect

Run scrapers conservatively. Hiking sites are mostly volunteer-funded —
don't slam them. Default `setDefaultTimeout(15s)` is intentionally
generous so we wait politely rather than hammering retries.
