// POST /generate
//
// Body: { "prompt": "string", "image_paths": ["string", ...], "project_id": "string" }
//   - image_paths are absolute filesystem paths already accessible to this
//     Node process (PO Agent and Proxi share a machine, so no upload step
//     is needed — they're passed straight through to setInputFiles()).
//   - project_id is optional; when present the chat is started from that
//     project's page so it can draw on the project's knowledge base.
//     Note image_paths remain per-message attachments either way — use
//     POST /projects/:id/knowledge to add to a project's persistent context.
//
// Drives the Playwright browser connection (src/browser.js) to send the
// prompt to Claude.ai and returns its response text.

const express = require("express");

const { sendPromptAndGetResponse, sendPromptInProject } = require("../browser");

const router = express.Router();

router.post("/", async (req, res) => {
  const {
    prompt,
    image_paths: imagePaths = [],
    project_id: projectId,
  } = req.body || {};

  if (typeof prompt !== "string" || prompt.trim() === "") {
    return res.status(400).json({ error: "prompt is required" });
  }

  try {
    const response = projectId
      ? await sendPromptInProject(projectId, prompt, imagePaths)
      : await sendPromptAndGetResponse(prompt, imagePaths);
    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
