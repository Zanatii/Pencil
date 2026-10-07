// Claude Projects endpoints.
//
//   GET  /projects                  -> list projects
//   POST /projects                  -> { name, description? } -> create
//   POST /projects/:id/knowledge    -> add files to a project's knowledge base
//
// The knowledge route accepts either shape:
//   - multipart/form-data with one or more "files" parts (for callers that
//     don't share a filesystem with this process)
//   - application/json { "file_paths": ["C:\\abs\\path.md", ...] }, matching
//     the same-machine convention /generate already uses for image_paths
//
// Playwright's setInputFiles() needs real paths on disk either way, so
// multipart parts are spooled to a temp dir and cleaned up afterwards.

const fs = require("fs");
const os = require("os");
const path = require("path");

const express = require("express");
const multer = require("multer");

const {
  listProjects,
  createProject,
  uploadToProjectKnowledge,
} = require("../browser");

const router = express.Router();

// Spool to disk (not memory) — knowledge files can be large, and we need a
// real path for setInputFiles regardless.
const upload = multer({
  dest: path.join(os.tmpdir(), "proxi-knowledge-uploads"),
  limits: { fileSize: 100 * 1024 * 1024 },
});

router.get("/", async (req, res) => {
  try {
    res.json({ projects: await listProjects() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req, res) => {
  const { name, description = "" } = req.body || {};

  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    const id = await createProject(name, description);
    res.status(201).json({ id, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/knowledge", upload.array("files"), async (req, res) => {
  const uploaded = req.files || [];
  // multer gives temp paths with no extension; claude.ai's project input
  // filters on extension, so restore the original name before handing it over.
  const renamed = [];

  try {
    for (const file of uploaded) {
      const target = path.join(path.dirname(file.path), file.originalname);
      fs.renameSync(file.path, target);
      renamed.push(target);
    }

    const jsonPaths = Array.isArray(req.body?.file_paths) ? req.body.file_paths : [];
    const filepaths = [...renamed, ...jsonPaths];

    if (filepaths.length === 0) {
      return res.status(400).json({
        error: 'no files provided — send multipart "files" parts or JSON { file_paths: [...] }',
      });
    }

    await uploadToProjectKnowledge(req.params.id, filepaths);
    res.json({ ok: true, uploaded: filepaths.map((p) => path.basename(p)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    // Only clean up what we spooled; never delete a caller-supplied path.
    for (const target of renamed) {
      try {
        fs.unlinkSync(target);
      } catch (err) {
        console.warn("projects: temp cleanup failed:", err.message);
      }
    }
  }
});

module.exports = router;
