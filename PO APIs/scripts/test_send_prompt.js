// Manual smoke test for sendPromptAndGetResponse() in src/browser.js.
//
// Sends a simple deterministic prompt with no attachments and prints
// whatever text comes back from Claude's response.
//
// Usage: node scripts/test_send_prompt.js

const { sendPromptAndGetResponse } = require("../src/browser");

async function main() {
  const reply = await sendPromptAndGetResponse(
    "Reply with exactly the word PONG and nothing else.",
    []
  );
  console.log("Response:", JSON.stringify(reply));

  // sendPromptAndGetResponse() doesn't hand back the page/browser handle
  // (its return contract is just the text), and the underlying CDP
  // connection stays open, so force the process to exit rather than
  // hang waiting on it. The debug Chrome instance and chat tab stay open.
  process.exit(0);
}

main().catch((err) => {
  console.error("test_send_prompt.js failed:", err);
  process.exit(1);
});
