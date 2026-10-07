// Playwright connection to a Chrome debug instance.
//
// This module connects to an already-running Chrome instance via CDP
// (launched separately with --remote-debugging-port, see .env.example's
// CHROME_DEBUG_PORT) and hands back a ready-to-use page in the existing
// browser context, so we reuse whatever session/cookies are already
// logged in rather than starting fresh.

require("dotenv").config();

const { execFile } = require("child_process");
const path = require("path");

const { chromium } = require("playwright");

const { withFocusGuard } = require("./focus");

/**
 * Logs whether the debug Chrome window is currently minimized/foreground.
 *
 * Diagnostic only, and OFF unless DEBUG_CHROME_WINDOW=1 — it shells out to
 * PowerShell for the user32 calls (Node has no built-in way to read window
 * state), which costs a process spawn, so it is not something to pay for on
 * every request. Enable it if the "pulled to that tab" symptom is ever
 * reported again, to test the minimized-window hypothesis from the earlier
 * investigation.
 */
async function logChromeWindowState() {
  if (process.env.DEBUG_CHROME_WINDOW !== "1") return;
  if (process.platform !== "win32") return;

  const ps = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$c = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
     Where-Object { $_.CommandLine -like '*--remote-debugging-port=${process.env.CHROME_DEBUG_PORT}*' }
$fg = [W]::GetForegroundWindow()
foreach ($x in $c) {
  $p = Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) {
    "pid=$($p.Id) minimized=$([W]::IsIconic($p.MainWindowHandle)) foreground=$($p.MainWindowHandle -eq $fg) title=$($p.MainWindowTitle)"
  }
}`;

  await new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err) console.warn("logChromeWindowState failed:", err.message);
        else for (const line of stdout.trim().split(/\r?\n/).filter(Boolean)) {
          console.log("[chrome-window]", line);
        }
        resolve();
      }
    );
  });
}

const NEW_CHAT_URL = "https://claude.ai/new";
// The sidebar "Projects" link points at /cowork/projects (confirmed by live
// inspection — it is NOT /projects, though the in-project back-link uses that
// shorter form).
const PROJECTS_URL = "https://claude.ai/cowork/projects";
const projectUrl = (projectId) => `https://claude.ai/project/${projectId}`;

/**
 * Opens a tab WITHOUT making it the active tab in the user's Chrome window.
 *
 * context.newPage() creates a foreground tab: the debug Chrome window's
 * active tab visibly switches to about:blank and stays switched until the
 * page is closed. If the user happens to be looking at that window, that is
 * the disruption they experience — measured at ~10s of hijacked tab for a
 * single listProjects() call. (An OS-level *window* focus steal was
 * investigated separately and could not be reproduced in 6 clean trials; tab
 * activation, not window activation, is the reproducible symptom.)
 *
 * CDP's Target.createTarget takes a `background` flag that newPage() does not
 * expose. Playwright still adopts the resulting target as a normal Page, so
 * everything downstream is unchanged.
 *
 * @param {import("playwright").Browser} browser
 * @param {import("playwright").BrowserContext} context
 * @returns {Promise<import("playwright").Page>}
 */
async function newBackgroundPage(browser, context) {
  const cdp = await browser.newBrowserCDPSession();

  try {
    // Snapshot existing pages so the new target can be identified without
    // racing a concurrent request's tab (routes can overlap: a long
    // /generate can be in flight while /projects is called).
    const before = new Set(context.pages());

    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
      background: true,
    });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      for (const candidate of context.pages()) {
        if (before.has(candidate) || candidate.isClosed()) continue;

        // Confirm identity by targetId rather than trusting arrival order.
        let session;
        try {
          session = await context.newCDPSession(candidate);
          const info = await session.send("Target.getTargetInfo");
          if (info?.targetInfo?.targetId === targetId) return candidate;
        } catch {
          // Page vanished or is not attachable — skip it.
        } finally {
          await session?.detach().catch(() => {});
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    throw new Error("newBackgroundPage: background target never surfaced as a page");
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Connects to the running Chrome debug instance, reuses its existing
 * browser context, opens a new tab navigated to `startUrl`, and returns
 * that page.
 *
 * @param {string} [startUrl] - defaults to a fresh unscoped chat
 * @param {{ background?: boolean }} [options] - background:true opens the tab
 *   without stealing the user's active tab (see newBackgroundPage). Falls
 *   back to a normal foreground tab if the CDP call is unsupported.
 * @returns {Promise<import("playwright").Page>}
 */
async function getPage(startUrl = NEW_CHAT_URL, { background = false } = {}) {
  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${process.env.CHROME_DEBUG_PORT}`
  );

  // Reuse the existing context (and its logged-in session) instead of
  // spinning up a fresh, unauthenticated one.
  const context = browser.contexts()[0];

  let page;
  if (background) {
    await logChromeWindowState();
    try {
      page = await newBackgroundPage(browser, context);
    } catch (err) {
      console.warn(
        "getPage: background tab unavailable, falling back to foreground:",
        err.message
      );
      page = await context.newPage();
    }
  } else {
    page = await context.newPage();
  }

  await page.goto(startUrl);

  return page;
}

// Selectors below were confirmed against the live claude.ai DOM (role- and
// data-testid-based, not brittle CSS classes) rather than guessed:
//   - prompt box:   role=textbox, accessible name "Write your prompt to Claude"
//   - send button:  role=button, accessible name "Send message"
//   - stop button:  role=button, accessible name "Stop response"
//                   (present while streaming, removed once the reply finishes)
//   - file input:   [data-testid="file-upload"] — this *is* the <input type="file">
//                   itself, no need to dig for a nested/hidden one
//   - response text: ".font-claude-response" — take the last one on the page
//                   (there's one per assistant turn) and read its innerText
//   - delete flow:  the chat title header (data-testid="page-header") has its
//                   own "More options for {title}" button (aria-haspopup=menu) —
//                   distinct from the identically-labeled buttons in the sidebar
//                   history, so it must be scoped to the header. That opens a
//                   menu with a "Delete" menuitem, which opens a confirmation
//                   panel titled "Delete chat" (role="alertdialog", not
//                   "dialog") containing its own "Delete" button to confirm.

const SEND_TIMEOUT_MS = 560_000;
// Knowledge-base ingestion is slower than a chat attachment (the file is
// parsed and indexed server-side), but nowhere near a full response wait.
const UPLOAD_TIMEOUT_MS = 180_000;

// A project page carries TWO file inputs, and they are NOT interchangeable:
//   - [data-testid="file-upload"]        attaches to the pending chat message
//   - [data-testid="project-doc-upload"] adds to the project knowledge base
//     ("Context"), which is what the "Add files" button under that heading
//     proxies to. It is a plain hidden input — clicking "Add files" opens no
//     dialog and fires no filechooser event, so setInputFiles works directly.
// Using the former for knowledge uploads silently produces a composer
// attachment that vanishes on navigation, leaving Context empty.
const FILE_INPUT_SELECTOR = '[data-testid="file-upload"]';
const PROJECT_DOC_INPUT_SELECTOR = '[data-testid="project-doc-upload"]';

/**
 * Shared prompt flow: on an already-open composer page (a fresh chat or a
 * project page — the composer is the same component either way), sends a
 * prompt with optional attachments, waits for streaming to finish, returns
 * the reply text, and always cleans up the chat/tab afterwards.
 *
 * Callers differ only in which URL the page was opened at, which is what
 * scopes the resulting chat to a project (or not).
 *
 * @param {import("playwright").Page} page
 * @param {string} prompt
 * @param {string[]} attachmentPaths - absolute paths to files to attach
 * @returns {Promise<string>}
 */
async function runPromptFlow(page, prompt, attachmentPaths) {
  try {
    const textbox = page.getByRole("textbox", {
      name: "Write your prompt to Claude",
    });
    await textbox.waitFor({ state: "visible", timeout: 15_000 });

    if (attachmentPaths.length > 0) {
      const fileInput = page.locator(FILE_INPUT_SELECTOR);
      await fileInput.setInputFiles(attachmentPaths);
      // Give the attachment preview a moment to finish uploading/rendering
      // before we submit, so the message doesn't send without it attached.
      await page.waitForTimeout(1_500);
    }

    await textbox.click();
    await textbox.fill(prompt);

    // Clicking "Send message" proved more reliable than pressing Enter,
    // which risks inserting a newline in the rich-text composer instead.
    await page.getByRole("button", { name: "Send message" }).click();

    const stopButton = page.getByRole("button", { name: "Stop response" });
    // Streaming may start and finish fast enough that we miss "visible" — that's
    // fine, we only care that it's gone by the time we read the response.
    await stopButton
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => {});
    await stopButton.waitFor({ state: "detached", timeout: SEND_TIMEOUT_MS });

    // Scope to the message feed: on a project-scoped chat the page also has a
    // breadcrumb link carrying .font-claude-response with the PROJECT NAME in
    // it, which sorts after the real reply — an unscoped .last() returns the
    // project title instead of Claude's answer. The feed contains only actual
    // messages, in both project and unscoped chats.
    const response = page.locator('[role="feed"] .font-claude-response').last();
    await response.waitFor({ state: "visible", timeout: 5_000 });

    return await response.innerText();
  } finally {
    // Always attempt cleanup — on success, on error, and on timeout — so a
    // chat/tab is never left behind. deleteChat and page.close() each get
    // their own try/catch so a cleanup failure can't mask the original
    // error (or clobber an otherwise-good response).
    try {
      await deleteChat(page);
    } catch (err) {
      console.warn("runPromptFlow: deleteChat failed:", err.message);
    }

    try {
      await page.close();
    } catch (err) {
      console.warn("runPromptFlow: page.close failed:", err.message);
    }
  }
}

/**
 * Opens a fresh claude.ai/new tab, sends a prompt (optionally with file
 * attachments), waits for Claude's reply to finish streaming, and returns
 * the reply's text content.
 *
 * @param {string} prompt
 * @param {string[]} [imagePaths] - absolute paths to files to attach
 * @returns {Promise<string>}
 */
async function sendPromptAndGetResponseImpl(prompt, imagePaths = []) {
  const page = await getPage(NEW_CHAT_URL);
  return runPromptFlow(page, prompt, imagePaths);
}

/**
 * Same as sendPromptAndGetResponse, but the chat is started from the
 * project's own page so it is scoped to that project's knowledge base.
 *
 * There is no distinct "New chat" control inside a project — the project
 * page embeds the same composer as /new, and scoping comes purely from
 * which page the prompt is typed into (confirmed by live inspection).
 *
 * @param {string} projectId
 * @param {string} prompt
 * @param {string[]} [attachmentPaths] - per-call attachments, NOT added to
 *   the project's persistent knowledge base (use uploadToProjectKnowledge
 *   for that)
 * @returns {Promise<string>}
 */
async function sendPromptInProjectImpl(projectId, prompt, attachmentPaths = []) {
  const page = await getPage(projectUrl(projectId));
  return runPromptFlow(page, prompt, attachmentPaths);
}

/**
 * Lists the projects visible on the projects page.
 *
 * Each project is an <a href="/project/{uuid}"> whose accessible name is the
 * whole card (title + subtitle + description + date) run together, so the
 * name is taken from the first line of innerText rather than the accessible
 * name, which is too noisy to use directly.
 *
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
async function listProjectsImpl() {
  // background:true — this runs on demand while the user may be working in
  // the same Chrome window, and must not hijack their active tab.
  const page = await getPage(PROJECTS_URL, { background: true });

  try {
    // Scoped to <main>: the sidebar on this page also renders /project/ links
    // (pinned projects), which otherwise show up as duplicate ids with empty
    // names. Deduping below is a second guard for cards that themselves use
    // an overlay anchor plus a content anchor.
    const links = page.locator('main a[href*="/project/"]');
    // The list renders client-side; give it a beat to populate. An empty
    // account legitimately has zero projects, so a timeout here is not an
    // error — fall through and return [].
    await links
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => {});

    return await links.evaluateAll((nodes) => {
      const byId = new Map();
      for (const node of nodes) {
        const href = node.getAttribute("href") || "";
        const id = (href.match(/\/project\/([^/?#]+)/) || [])[1];
        if (!id) continue;
        const name = (node.innerText || node.textContent || "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)[0];
        // Keep the first entry that actually has a name — an id can appear
        // more than once, and the overlay anchor of a card has no text.
        if (name && !byId.get(id)) byId.set(id, { id, name });
      }
      return [...byId.values()];
    });
  } finally {
    try {
      await page.close();
    } catch (err) {
      console.warn("listProjects: page.close failed:", err.message);
    }
  }
}

/**
 * Creates a project and returns its new id.
 *
 * Note the projects page has two buttons matching /create|new project/i: an
 * icon-only trigger (aria-label "Create project") and a text "New project"
 * button. Matching the accessible name "Create project" exactly picks the
 * icon trigger and leaves the text one alone. The dialog's own submit button
 * shares that accessible name, hence the dialog-scoped locator for it.
 *
 * @param {string} name
 * @param {string} [description]
 * @returns {Promise<string>} the new project's id
 */
async function createProjectImpl(name, description = "") {
  const page = await getPage(PROJECTS_URL);

  try {
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();

    const dialog = page
      .locator('[role="dialog"], [role="alertdialog"]')
      .filter({ hasText: "Create a project" });
    await dialog.waitFor({ state: "visible", timeout: 15_000 });

    await dialog
      .getByRole("textbox", { name: "What are you working on?" })
      .fill(name);

    if (description) {
      await dialog
        .getByRole("textbox", { name: "What are you trying to achieve?" })
        .fill(description);
    }

    await dialog.locator('button[type="submit"]').click();

    // Creating a project navigates into it; the id is only available from
    // the resulting URL.
    await page.waitForURL(/\/project\/[^/?#]+/, { timeout: 30_000 });

    const id = (page.url().match(/\/project\/([^/?#]+)/) || [])[1];
    if (!id) {
      throw new Error(`createProject: could not parse project id from ${page.url()}`);
    }
    return id;
  } finally {
    try {
      await page.close();
    } catch (err) {
      console.warn("createProject: page.close failed:", err.message);
    }
  }
}

/**
 * Uploads files into a project's persistent knowledge base ("Context").
 *
 * Waits for each file to actually appear in the Context list before
 * returning, rather than firing and forgetting — the list renders one
 * button per file, named "{filename}, {ext}, {size}".
 *
 * @param {string} projectId
 * @param {string[]} filepaths - absolute paths
 * @returns {Promise<void>}
 */
async function uploadToProjectKnowledgeImpl(projectId, filepaths) {
  if (!filepaths || filepaths.length === 0) {
    throw new Error("uploadToProjectKnowledge: filepaths is empty");
  }

  const page = await getPage(projectUrl(projectId));

  try {
    const fileInput = page.locator(PROJECT_DOC_INPUT_SELECTOR);
    await fileInput.waitFor({ state: "attached", timeout: 15_000 });
    await fileInput.setInputFiles(filepaths);

    // Confirm ingestion completed by waiting for each filename to show up as
    // a card in the Context list. Matching on the basename as a substring,
    // since the card's accessible name appends type and size
    // ("notes.md, md, 1.2kB").
    //
    // Waits on "attached", not "visible": the card is a zero-size
    // <span role="button"> whose hit area comes from an absolutely-positioned
    // ::after overlay, so Playwright always reports it hidden even once it has
    // rendered. Presence in the DOM is the real completion signal here.
    for (const filepath of filepaths) {
      const basename = path.basename(filepath);
      await page
        .locator("main")
        .getByRole("button", { name: basename, exact: false })
        .first()
        .waitFor({ state: "attached", timeout: UPLOAD_TIMEOUT_MS });
    }
  } finally {
    try {
      await page.close();
    } catch (err) {
      console.warn("uploadToProjectKnowledge: page.close failed:", err.message);
    }
  }
}

/**
 * Deletes the conversation currently open in `page` via the chat header's
 * "More options" menu → "Delete" → confirm. Assumes `page` is on an actual
 * chat (i.e. already sent at least one message, not still on /new).
 *
 * @param {import("playwright").Page} page
 * @returns {Promise<void>}
 */
async function deleteChat(page) {
  // The chat header's menu button name is DYNAMIC: it is plain "More options"
  // while the chat is still Untitled, and becomes "More options for {title}"
  // once Claude auto-titles the conversation — so neither exact name is safe
  // to match on. What is stable is location: the sidebar's many
  // "More options for {conversation}" buttons all live outside <main>, and
  // exactly one such button lives inside it, the current chat's own.
  //
  // (This previously scoped to [data-testid="page-header"], an element that no
  // longer exists in the DOM, so every delete was silently failing.)
  await page
    .locator("main")
    .getByRole("button", { name: /^More options/ })
    .first()
    .click();

  await page.getByRole("menuitem", { name: /delete/i }).click();

  const confirmDialog = page
    .locator('[role="dialog"], [role="alertdialog"]')
    .filter({ hasText: "Delete chat" });
  await confirmDialog.waitFor({ state: "visible", timeout: 5_000 });

  await confirmDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await confirmDialog.waitFor({ state: "detached", timeout: 10_000 });
}

// Every public entry point goes out wrapped in the focus guard: it captures
// the user's foreground window before any Playwright work starts and puts it
// back if the debug Chrome ended up stealing it (see src/focus.js). Exporting
// only the wrapped forms means a new caller cannot accidentally bypass it.
const sendPromptAndGetResponse = (prompt, imagePaths = []) =>
  withFocusGuard("sendPromptAndGetResponse", () =>
    sendPromptAndGetResponseImpl(prompt, imagePaths)
  );

const sendPromptInProject = (projectId, prompt, attachmentPaths = []) =>
  withFocusGuard("sendPromptInProject", () =>
    sendPromptInProjectImpl(projectId, prompt, attachmentPaths)
  );

const listProjects = () => withFocusGuard("listProjects", () => listProjectsImpl());

const createProject = (name, description = "") =>
  withFocusGuard("createProject", () => createProjectImpl(name, description));

const uploadToProjectKnowledge = (projectId, filepaths) =>
  withFocusGuard("uploadToProjectKnowledge", () =>
    uploadToProjectKnowledgeImpl(projectId, filepaths)
  );

module.exports = {
  getPage,
  sendPromptAndGetResponse,
  sendPromptInProject,
  listProjects,
  createProject,
  uploadToProjectKnowledge,
  deleteChat,
};
