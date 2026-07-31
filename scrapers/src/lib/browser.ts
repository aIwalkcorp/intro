import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/**
 * Launch a Chromium session tuned for scraping:
 *  - Headless by default, flip via HEADLESS=0 for debugging.
 *  - Realistic UA + viewport so sites don't serve us mobile/bot variants.
 *  - 30s default navigation timeout (mountain sites are sometimes slow).
 */
export async function openBrowser(opts: { headless?: boolean } = {}): Promise<BrowserSession> {
  const headless = opts.headless ?? process.env.HEADLESS !== "0";
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 trailforge-scraper/0.1",
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
  });
  context.setDefaultNavigationTimeout(30_000);
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}
