// Manual smoke test for src/browser.js.
//
// Opens a new tab to claude.ai/new in the running debug Chrome instance,
// pauses so you can visually confirm it in the browser window, then
// closes just that tab (leaves the browser running).
//
// Usage: node scripts/test_browser.js

const { getPage } = require("../src/browser");

async function main() {
  console.log("Opening a new tab to claude.ai/new...");
  const page = await getPage();

  console.log("Tab opened. Waiting 3 seconds for visual confirmation...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log("Current URL:", page.url());

  // Close just the tab, not the whole browser (it's a shared debug instance).
  await page.close();
  console.log("Page closed.");

  // Disconnect this script's CDP session so the process can exit; the
  // debug Chrome instance itself keeps running.
  await page.context().browser().close();
}

main().catch((err) => {
  console.error("test_browser.js failed:", err);
  process.exit(1);
});
