/**
 * 健行筆記 scraper — searches by keyword + pulls the top N trip-report cards.
 *
 * Usage:
 *   bun run hiking-notes -- 玉山                  # search by keyword
 *   bun run hiking-notes -- 玉山 5                # top 5 results
 *   HEADLESS=0 bun run hiking-notes -- 奇萊南華   # watch the run
 *
 * Output: scrapers/out/hiking-notes-<keyword>.json
 */
import { openBrowser } from "./lib/browser.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "out");

interface Result {
  title: string;
  href: string;
  excerpt?: string;
  author?: string;
  date?: string;
}

async function main() {
  const args = process.argv.slice(2);
  const keyword = args[0] || "玉山";
  const limit = parseInt(args[1] || "10", 10);

  await mkdir(outDir, { recursive: true });

  const session = await openBrowser();
  try {
    const url = `https://hiking.biji.co/index.php?q=${encodeURIComponent(keyword)}&type=site_search`;
    console.log("→", url);
    // 健行筆記 sometimes serves heavy ad iframes — use a generous timeout and
    // settle for `commit` (got headers + URL) rather than `domcontentloaded`.
    await session.page.goto(url, { waitUntil: "commit", timeout: 60_000 });
    await session.page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
    await session.page.waitForTimeout(2_000);

    // hiking.biji.co serves a Drupal-style listing; the layout markup
    // changes often. We rely on locator() + a recurring-nav-item blocklist
    // to focus on real article links. (page.evaluate would trip on tsx's
    // __name helper injection.)
    const NAV_NOISE = new Set([
      "淡蘭古道", "上傳照片", "上傳GPX", "分享心得", "提供路線",
      "登入", "註冊", "首頁", "回首頁", "更多",
    ]);
    const handles = await session.page.locator('a[href*="hiking.biji.co"]').all();
    const seen = new Set<string>();
    const results: Result[] = [];
    for (const h of handles) {
      const title = ((await h.textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      const href = (await h.getAttribute("href").catch(() => "")) || "";
      if (!title || title.length < 8) continue;
      if (NAV_NOISE.has(title)) continue;
      if (!href.includes("/index.php")) continue;
      if (seen.has(title)) continue;
      seen.add(title);
      results.push({ title, href });
      if (results.length >= limit) break;
    }

    const stub = `hiking-notes-${keyword.replace(/[^一-鿿A-Za-z0-9]+/g, "_")}`;
    const jsonPath = resolve(outDir, `${stub}.json`);
    await writeFile(
      jsonPath,
      JSON.stringify(
        { keyword, scraped_at: new Date().toISOString(), source: url, count: results.length, results },
        null,
        2
      )
    );

    console.log(`  ${results.length} result(s) → ${jsonPath}`);
    for (const r of results.slice(0, 5)) {
      console.log("  •", r.title);
    }
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
