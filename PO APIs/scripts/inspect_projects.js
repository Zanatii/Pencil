// THROWAWAY discovery script — Claude Projects support (creating projects,
// uploading to their knowledge base, listing existing ones, chats scoped to
// a project). No automation logic here, just read-only reconnaissance so we
// design the real selectors against confirmed reality instead of guesses.
//
// What this does NOT do: create a project, upload a file, or send a chat
// message. Two clicks are unavoidable to reveal transient UI state, and both
// are backed out of before anything is committed:
//   - "New project" is clicked to reveal its naming dialog, then Escape is
//     pressed immediately — no name is typed, no confirm button is pressed.
//   - If an existing project is found, we navigate into it (read-only) and
//     click its "New chat" control to see where it lands and how project
//     scoping shows up — but nothing is typed or sent.
//
// Usage: node scripts/inspect_projects.js

const { getPage } = require("../src/browser");

/**
 * Dumps a locator's matches as raw attributes (role/name aren't always
 * present as attributes for native elements — tag name covers those — but
 * href/data-testid/type are exactly what we need to build real selectors).
 */
async function logLocator(label, locator, { max = 15 } = {}) {
  const handles = await locator.all();
  console.log(`\n--- ${label} (${handles.length} match${handles.length === 1 ? "" : "es"}) ---`);
  for (const [i, el] of handles.slice(0, max).entries()) {
    const info = await el.evaluate((node) => ({
      tag: node.tagName.toLowerCase(),
      role: node.getAttribute("role"),
      ariaLabel: node.getAttribute("aria-label"),
      href: node.getAttribute("href"),
      testId: node.getAttribute("data-testid"),
      type: node.getAttribute("type"),
      text: (node.innerText || node.textContent || "").trim().slice(0, 80),
    }));
    console.log(`  [${i}]`, JSON.stringify(info));
  }
  if (handles.length > max) {
    console.log(`  ...and ${handles.length - max} more (truncated)`);
  }
  return handles.length;
}

/** Human-readable role/name tree for a container — the actual a11y tree. */
async function logAriaSnapshot(label, locator) {
  console.log(`\n=== aria snapshot: ${label} ===`);
  try {
    console.log(await locator.ariaSnapshot());
  } catch (err) {
    console.log(`  (failed to snapshot: ${err.message})`);
  }
}

async function main() {
  const page = await getPage(); // lands on claude.ai/new, already-authenticated context

  // ---------------------------------------------------------------------
  // 1. Sidebar "Projects" link — confirm its real href before guessing a URL
  // ---------------------------------------------------------------------
  console.log("\n############ 1. Sidebar 'Projects' link ############");
  await logAriaSnapshot("full sidebar nav", page.locator("nav").first());

  let projectsHref = null;
  const projectsLink = page.getByRole("link", { name: /^projects$/i });
  const linkCount = await logLocator('getByRole("link", { name: /^projects$/i })', projectsLink);
  if (linkCount > 0) {
    projectsHref = await projectsLink.first().getAttribute("href");
  } else {
    // Fallback: maybe it's a client-routed <button>, not a real <a href>.
    const projectsButton = page.getByRole("button", { name: /^projects$/i });
    await logLocator('fallback getByRole("button", { name: /^projects$/i })', projectsButton);
  }
  console.log("\nResolved Projects href:", projectsHref ?? "(none found — will fall back to /projects)");

  const projectsUrl = new URL(projectsHref ?? "/projects", "https://claude.ai").toString();
  console.log("Navigating to:", projectsUrl);
  await page.goto(projectsUrl);
  await page.waitForTimeout(1500);
  console.log("Landed on:", page.url());

  // ---------------------------------------------------------------------
  // 2. "New project" button + the name-input it reveals
  // ---------------------------------------------------------------------
  console.log("\n############ 2. 'New project' button ############");
  const newProjectBtn = page.getByRole("button", { name: /new project|create project/i });
  const newProjectCount = await logLocator(
    'getByRole("button", { name: /new project|create project/i })',
    newProjectBtn
  );

  if (newProjectCount > 0) {
    await newProjectBtn.first().click();
    await page.waitForTimeout(1000);

    const dialog = page.locator('[role="dialog"], [role="alertdialog"]');
    await logAriaSnapshot("'New project' dialog", dialog.first());
    await logLocator("input/textarea inside dialog", dialog.locator("input, textarea"));
    await logLocator("buttons inside dialog", dialog.getByRole("button"));

    // Back out WITHOUT typing a name or pressing any confirm button.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    const stillOpen = await dialog.count();
    console.log(
      stillOpen > 0
        ? "WARNING: dialog still present after Escape — leaving it, no name was typed so nothing will be created."
        : "Escape closed the dialog — no project created."
    );
  } else {
    console.log("No 'New project' button matched — skipping dialog inspection.");
  }

  // ---------------------------------------------------------------------
  // 3. How an existing project is listed
  // ---------------------------------------------------------------------
  console.log("\n############ 3. Existing project list items ############");
  const projectItemLinks = page.locator('a[href*="/project/"]');
  const projectItemCount = await logLocator('a[href*="/project/"]', projectItemLinks);
  await logAriaSnapshot("projects list container (best-effort: <main>)", page.locator("main").first());

  // ---------------------------------------------------------------------
  // 4 & 5. Inside a project: "Add content" upload control + "New chat" scoping
  // ---------------------------------------------------------------------
  console.log("\n############ 4/5. Inside a project ############");
  if (projectItemCount === 0) {
    console.log(
      "No existing projects found in this account — can't inspect in-project controls " +
        "(upload control, in-project 'New chat' scoping) without creating one. Skipping."
    );
  } else {
    const firstProjectHref = await projectItemLinks.first().getAttribute("href");
    const firstProjectUrl = new URL(firstProjectHref, "https://claude.ai").toString();
    console.log("Navigating into existing project (read-only):", firstProjectUrl);
    await page.goto(firstProjectUrl);
    await page.waitForTimeout(1500);
    console.log("Landed on:", page.url());

    await logAriaSnapshot("project page", page.locator("main").first());

    console.log("\n--- 'Add content' / upload control ---");
    const uploadButton = page.getByRole("button", { name: /add content|upload/i });
    await logLocator('getByRole("button", { name: /add content|upload/i })', uploadButton);
    await logLocator('[data-testid="file-upload"] (pattern reused from src/browser.js)', page.locator('[data-testid="file-upload"]'));
    await logLocator('input[type="file"]', page.locator('input[type="file"]'));

    console.log("\n--- In-project 'New chat' ---");
    const newChatControl = page.getByRole("button", { name: /new chat/i }).or(
      page.getByRole("link", { name: /new chat/i })
    );
    const newChatCount = await logLocator(
      'getByRole("button"|"link", { name: /new chat/i })',
      newChatControl
    );

    if (newChatCount > 0) {
      const urlBeforeClick = page.url();
      await newChatControl.first().click();
      await page.waitForTimeout(1500);
      console.log("URL before click:", urlBeforeClick);
      console.log("URL after click: ", page.url());
      console.log(
        "Scoping check: does the post-click URL still contain the project path? ->",
        page.url().includes(new URL(firstProjectUrl).pathname)
      );
      await logAriaSnapshot("post-click composer area", page.locator("main").first());
      console.log("(Nothing was typed or sent in this chat.)");
    } else {
      console.log("No 'New chat' control matched inside the project — skipping scoping check.");
    }
  }

  await page.close();
  console.log("\nDone. Tab closed; debug Chrome instance left running.");
  await page.context().browser().close();
}

main().catch((err) => {
  console.error("inspect_projects.js failed:", err);
  process.exit(1);
});
