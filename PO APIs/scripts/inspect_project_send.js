// THROWAWAY diagnostic: step through the in-project send flow with logging
// at each stage, to find why sendPromptInProject returned the project title
// instead of Claude's reply. Leaves the chat in place (no deleteChat).
//
// Usage: node scripts/inspect_project_send.js <projectId>

const { getPage } = require("../src/browser");

async function main() {
  const projectId = process.argv[2];
  if (!projectId) throw new Error("usage: node scripts/inspect_project_send.js <projectId>");

  const page = await getPage(`https://claude.ai/project/${projectId}`);

  const textbox = page.getByRole("textbox", { name: "Write your prompt to Claude" });
  await textbox.waitFor({ state: "visible", timeout: 15_000 });
  console.log("URL on load:", page.url());

  console.log("\n--- buttons BEFORE filling composer ---");
  for (const b of await page.getByRole("button").all()) {
    const n = await b.evaluate((el) => (el.getAttribute("aria-label") || el.innerText || "").trim().slice(0, 60));
    if (n) console.log("   ", JSON.stringify(n));
  }

  await textbox.click();
  await textbox.fill("Reply with exactly the word PONG and nothing else.");
  await page.waitForTimeout(1000);
  console.log("\ncomposer innerText after fill:", JSON.stringify(await textbox.innerText()));

  console.log("\n--- buttons AFTER filling composer ---");
  for (const b of await page.getByRole("button").all()) {
    const n = await b.evaluate((el) => (el.getAttribute("aria-label") || el.innerText || "").trim().slice(0, 60));
    if (n) console.log("   ", JSON.stringify(n));
  }

  const sendBtn = page.getByRole("button", { name: "Send message" });
  console.log("\n'Send message' match count:", await sendBtn.count());

  await sendBtn.first().click();
  console.log("clicked send; waiting 6s...");
  await page.waitForTimeout(6000);
  console.log("URL after send:", page.url());

  const stop = page.getByRole("button", { name: "Stop response" });
  console.log("'Stop response' count right after send:", await stop.count());

  await page.waitForTimeout(15000);
  console.log("URL after settle:", page.url());

  const resp = page.locator(".font-claude-response");
  console.log("\n.font-claude-response count:", await resp.count());
  for (const [i, r] of (await resp.all()).entries()) {
    console.log(`  [${i}]`, JSON.stringify((await r.innerText()).trim().slice(0, 120)));
  }

  console.log("\npage-header count:", await page.locator('[data-testid="page-header"]').count());
  console.log("\n=== full main aria snapshot ===");
  console.log(await page.locator("main").first().ariaSnapshot());

  console.log("\n(Chat left in place for inspection.)");
  process.exit(0);
}

main().catch((err) => {
  console.error("inspect_project_send.js failed:", err);
  process.exit(1);
});
