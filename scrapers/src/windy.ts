/**
 * Windy scraper — pulls a screenshot + a tiny JSON summary of forecast data
 * for a given lat/lon. Default coords are 玉山主峰 (23.470, 120.957).
 *
 * Usage:
 *   bun run windy                     # default coords
 *   bun run windy -- 23.5 121.4       # custom lat lon
 *   HEADLESS=0 bun run windy          # watch the browser
 *
 * Output written to scrapers/out/windy-<lat>-<lon>.{png,json}
 */
import { openBrowser } from "./lib/browser.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "out");

async function main() {
  const [latArg, lonArg] = process.argv.slice(2);
  const lat = parseFloat(latArg) || 23.4699;
  const lon = parseFloat(lonArg) || 120.9573;

  await mkdir(outDir, { recursive: true });

  const session = await openBrowser();
  try {
    const url = `https://www.windy.com/${lat}/${lon}?${lat},${lon},9`;
    console.log("→", url);
    await session.page.goto(url, { waitUntil: "domcontentloaded" });

    // Wait for the map UI to settle. Windy is a SPA — give it a beat.
    await session.page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await session.page.waitForTimeout(2_500);

    // Dismiss the cookie banner if present.
    const cookieBtn = session.page.locator('button:has-text("Accept"), button:has-text("接受")').first();
    if (await cookieBtn.isVisible().catch(() => false)) {
      await cookieBtn.click().catch(() => {});
      await session.page.waitForTimeout(500);
    }

    const stub = `windy-${lat.toFixed(3)}-${lon.toFixed(3)}`;
    const screenshotPath = resolve(outDir, `${stub}.png`);
    await session.page.screenshot({ path: screenshotPath, fullPage: false });

    // Extract whatever the detail panel currently has (wind, temp, precip).
    // Using locator() instead of page.evaluate() — the latter trips on tsx's
    // __name helper injection when serialising the callback.
    const data: Record<string, string> = {};
    const grab = async (sel: string, key: string) => {
      const t = await session.page.locator(sel).first().textContent({ timeout: 1500 }).catch(() => null);
      if (t) data[key] = t.replace(/\s+/g, " ").trim();
    };
    await grab("#detail-wind", "wind");
    await grab("#detail-temp", "temp");
    await grab("#detail-rh", "humidity");
    await grab(".picker", "picker");
    data.title = await session.page.title();
    const jsonPath = resolve(outDir, `${stub}.json`);
    await writeFile(
      jsonPath,
      JSON.stringify({ lat, lon, scraped_at: new Date().toISOString(), url, data }, null, 2)
    );

    console.log("  screenshot:", screenshotPath);
    console.log("  data:      ", jsonPath);
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
