// Manual smoke test for sendPromptAndGetResponse()'s image-attachment path
// in src/browser.js (imagePaths param).
//
// Attaches tests/fixtures/test_image.png (a solid red placeholder) and asks
// Claude to name its color, so the response itself proves whether the
// attachment actually came through.
//
// Usage: node scripts/test_image_attach.js

const path = require("path");
const { sendPromptAndGetResponse } = require("../src/browser");

async function main() {
  const imagePath = path.resolve(
    __dirname,
    "../tests/fixtures/test_image.png"
  );

  const reply = await sendPromptAndGetResponse(
    "Describe what color this image is in one word.",
    [imagePath]
  );
  console.log("Response:", JSON.stringify(reply));

  process.exit(0);
}

main().catch((err) => {
  console.error("test_image_attach.js failed:", err);
  process.exit(1);
});
