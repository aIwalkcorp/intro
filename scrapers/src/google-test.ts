import { openBrowser } from "./lib/browser.ts";

const s = await openBrowser();
try {
  console.log("→ 開啟 Google 搜尋頁");
  await s.page.goto("https://www.google.com/search?q=" + encodeURIComponent("今日天氣"), {
    waitUntil: "domcontentloaded",
  });
  await s.page.waitForTimeout(2000);
  await s.page.screenshot({ path: "out/google-today-weather.png", fullPage: false });
  const title = await s.page.title();
  console.log("  title:", title);
  const heads = await s.page.locator("h3").all();
  const titles: string[] = [];
  for (const h of heads.slice(0, 5)) {
    const t = ((await h.textContent().catch(() => "")) || "").trim();
    if (t) titles.push(t);
  }
  console.log("  前 5 個結果標題:");
  titles.forEach((t, i) => console.log(`    ${i + 1}. ${t}`));
} finally {
  await s.close();
}
