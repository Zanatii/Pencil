// Manual end-to-end test for the Projects support in src/browser.js.
//
// Creates ONE test project, uploads a small fixture with a distinctive fact,
// asks a question only answerable from that fixture, and reports whether the
// answer came back. The test project is intentionally left in place.
//
// Usage: node scripts/test_projects.js
//        node scripts/test_projects.js --list-only
//        node scripts/test_projects.js --project-id=<uuid>   (reuse, don't create)

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  listProjects,
  createProject,
  uploadToProjectKnowledge,
  sendPromptInProject,
} = require("../src/browser");

// A fact that cannot be answered from general knowledge — if it comes back,
// the knowledge base was genuinely consulted.
const CANARY = "The Proxi build codename for Q3 2026 is BRASSWORK-7719.";

async function main() {
  const listOnly = process.argv.includes("--list-only");

  console.log("=== 1. listProjects() ===");
  const before = await listProjects();
  console.log(JSON.stringify(before, null, 2));
  if (listOnly) return process.exit(0);

  const reuseArg = process.argv.find((a) => a.startsWith("--project-id="));

  let id;
  let name;
  if (reuseArg) {
    id = reuseArg.split("=")[1];
    name = (before.find((p) => p.id === id) || {}).name || "(unknown)";
    console.log("\n=== 2. createProject() — SKIPPED, reusing", id, "===");
  } else {
    console.log("\n=== 2. createProject() ===");
    name = `Proxi Test Project ${new Date().toISOString().slice(0, 10)}`;
    id = await createProject(name, "Throwaway project for Proxi API integration testing.");
    console.log("Created project id:", id, "name:", JSON.stringify(name));
  }

  console.log("\n=== 3. uploadToProjectKnowledge() ===");
  const fixture = path.join(os.tmpdir(), "proxi-canary.md");
  fs.writeFileSync(fixture, `# Proxi Internal Notes\n\n${CANARY}\n`, "utf8");
  console.log("Fixture:", fixture);
  await uploadToProjectKnowledge(id, [fixture]);
  console.log("Upload confirmed present in Context list.");

  console.log("\n=== 4. sendPromptInProject() ===");
  const reply = await sendPromptInProject(
    id,
    "According to the files in this project's knowledge, what is the Proxi build codename for Q3 2026? Reply with just the codename."
  );
  console.log("Reply:", JSON.stringify(reply));
  console.log(
    reply.includes("BRASSWORK-7719")
      ? "\nPASS: response cites the uploaded file's content — project scoping confirmed."
      : "\nFAIL: response did NOT contain the canary; knowledge may not have been consulted."
  );

  console.log("\n=== 5. listProjects() again ===");
  console.log(JSON.stringify(await listProjects(), null, 2));

  console.log(`\nTest project left in place: ${name} (${id})`);
  process.exit(0);
}

main().catch((err) => {
  console.error("test_projects.js failed:", err);
  process.exit(1);
});
