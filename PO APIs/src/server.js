// Express app entrypoint.
// Loads environment config, wires up middleware and routes, and starts the HTTP server.

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const generateRouter = require("./routes/generate");
const projectsRouter = require("./routes/projects");

const app = express();

app.use(cors());
// 50mb limit to leave headroom for base64-encoded payloads (e.g. screenshots/PDFs).
app.use(express.json({ limit: "50mb" }));

app.use("/generate", generateRouter);
app.use("/projects", projectsRouter);

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 4001;

const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// /generate can take several minutes for large document processing (the
// browser automation layer waits up to ~560s for a response). Node's HTTP
// server has its own timeouts sitting below Express, independent of
// anything in routes/generate.js, so raise them here to keep a slow
// in-flight request from being killed out from under the route handler.
server.timeout = 0; // disable the idle socket timeout (no cap on handler duration)
server.requestTimeout = 600_000; // 600s cap on receiving the full request; must exceed headersTimeout
server.keepAliveTimeout = 605_000; // keep-alive idle window, kept above requestTimeout for headroom
