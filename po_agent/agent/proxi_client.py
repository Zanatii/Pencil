"""Client for the standalone PO Agent Proxi service.

Proxi is a separate Node/Express/Playwright process (not part of this
Python app) that drives Claude.ai via a debug Chrome instance and
exposes a simple HTTP API. It must be running (PORT from PROXI_URL)
for calls here to succeed.
"""

import os
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv()

DEFAULT_PROXI_URL = "http://127.0.0.1:4001"
REQUEST_TIMEOUT_SECONDS = 600
"""10 minutes — large PDF attachments can take Claude a while to process,
and Proxi's own request/response round trip (driving Claude.ai via
Playwright, not a direct API call) is slower than a normal API timeout
budget would assume."""


def call_claude_via_proxi(
    prompt: str,
    content: str,
    image_paths: list[str] = None,
    project_id: str | None = None,
) -> str:
    """
    Calls the standalone PO Agent Proxi service (separate Node/Express/Playwright
    process, must be running on PORT from PROXI_URL) which drives Claude.ai via
    a debug Chrome instance and returns the raw response text.

    project_id, when given, is forwarded to Proxi as-is in the request
    body; it's up to Proxi's own /generate route to notice it and switch
    from its plain flow to sendPromptInProject (see also list_projects/
    create_project/upload_to_project below, which manage the projects
    this id would reference).
    """
    proxi_url = os.environ.get("PROXI_URL", DEFAULT_PROXI_URL).rstrip("/")
    combined_message = f"{prompt}\n\n---\n\n{content}"

    payload = {"prompt": combined_message, "image_paths": image_paths or []}
    if project_id is not None:
        payload["project_id"] = project_id

    try:
        response = requests.post(
            f"{proxi_url}/generate",
            json=payload,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"Proxi request failed: {exc}") from exc

    if response.status_code != 200:
        raise RuntimeError(f"Proxi returned {response.status_code}: {response.text}")

    return response.json()["response"]


def list_projects() -> list[dict]:
    """Return the PO's Claude.ai projects, for the frontend's project picker.

    Proxi's own response is {"projects": [...]} , not a bare array — this
    unwraps it so callers here just deal in a plain list, matching what
    GET /claude-projects (routes.py) hands straight to the frontend.
    """
    proxi_url = os.environ.get("PROXI_URL", DEFAULT_PROXI_URL).rstrip("/")

    try:
        response = requests.get(f"{proxi_url}/projects", timeout=30)
    except requests.RequestException as exc:
        raise RuntimeError(f"Proxi request failed: {exc}") from exc

    if response.status_code != 200:
        raise RuntimeError(f"Proxi returned {response.status_code}: {response.text}")

    return response.json()["projects"]


def create_project(name: str, description: str = "") -> str:
    """Create a new Claude.ai project via Proxi. Returns the new project's id."""
    proxi_url = os.environ.get("PROXI_URL", DEFAULT_PROXI_URL).rstrip("/")

    try:
        response = requests.post(
            f"{proxi_url}/projects",
            json={"name": name, "description": description},
            timeout=60,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"Proxi request failed: {exc}") from exc

    # Proxi's POST /projects returns 201 Created (correct REST convention for
    # a resource-creation endpoint), not 200 — accept any 2xx rather than
    # requiring an exact match, so this doesn't misclassify a real success as
    # a failure again the next time Proxi's status code is technically-correct
    # but different from what this check narrowly expects.
    if not response.ok:
        raise RuntimeError(f"Proxi returned {response.status_code}: {response.text}")

    return response.json()["id"]


def upload_to_project(project_id: str, filepaths: list[str]) -> None:
    """Upload local files into a Claude.ai project's knowledge base via Proxi.

    Multipart upload, same shape as the app's own attachment endpoints —
    opens each file fresh (not held open across the request) so a large
    batch doesn't leave file handles open for the whole upload.
    """
    if not filepaths:
        return

    proxi_url = os.environ.get("PROXI_URL", DEFAULT_PROXI_URL).rstrip("/")

    open_files = []
    try:
        files = []
        for filepath in filepaths:
            path = Path(filepath)
            handle = path.open("rb")
            open_files.append(handle)
            files.append(("files", (path.name, handle)))

        try:
            response = requests.post(
                f"{proxi_url}/projects/{project_id}/knowledge",
                files=files,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except requests.RequestException as exc:
            raise RuntimeError(f"Proxi request failed: {exc}") from exc
    finally:
        for handle in open_files:
            handle.close()

    if response.status_code != 200:
        raise RuntimeError(f"Proxi returned {response.status_code}: {response.text}")
