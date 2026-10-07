// THROWAWAY diagnostic: inspect a chat page's header controls and exercise
// the delete flow, so deleteChat() targets confirmed reality.
//
// Usage: node scripts/inspect_delete_chat.js <chatId> [--delete]

const { getPage, deleteChat } = require("../src/browser");

async function main() {
  const chatId = process.argv[2];
  if (!chatId) throw new Error("usage: node scripts/inspect_delete_chat.js <chatId> [--delete]");

  const page = await getPage(`https://claude.ai/chat/${chatId}`);
  await page.waitForTimeout(4000);
  console.log("URL:", page.url());

  console.log("\n--- exact-name 'More options' count ---");
  console.log(await page.getByRole("button", { name: "More options", exact: true }).count());

  console.log("\n--- ALL buttons whose name contains 'More options' ---");
  for (const b of await page.getByRole("button", { name: /More options/i }).all()) {
    const info = await b.evaluate((el) => ({
      name: (el.getAttribute("aria-label") || el.innerText || "").trim().slice(0, 50),
      testId: el.getAttribute("data-testid"),
      inMain: !!el.closest("main"),
      inNav: !!el.closest("nav"),
    }));
    console.log("   ", JSON.stringify(info));
  }

  console.log("\n--- header region aria snapshot (main > first children) ---");
  console.log(await page.locator("main").first().ariaSnapshot({ ref: false }).catch((e) => e.message));

  if (process.argv.includes("--delete")) {
    console.log("\n--- exercising deleteChat() ---");
    await deleteChat(page);
    console.log("deleteChat() returned without throwing. URL now:", page.url());
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("inspect_delete_chat.js failed:", err.message);
  process.exit(1);
});
