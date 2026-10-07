"""REST endpoints for the PO Agent API.

This module holds the routers for pipeline operations (uploading
documents, triggering runs, checking status, reviewing/approving steps,
and pushing results to JIRA). Most of that is still to come; currently
just the read-only epic-fetch endpoint and the division-review endpoint.
"""

import json
import logging
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

import json_repair
import requests
from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, ValidationError

from po_agent.agent.prompts.division import PROMPT_DIVISION
from po_agent.agent.prompts.story_detail import PROMPT_STORY_DETAIL
from po_agent.agent.proxi_client import (
    call_claude_via_proxi,
    create_project,
    list_projects,
    upload_to_project,
)
from po_agent.core.state import PipelineState, RunStatus, StoryDivisionItem, UserStory
from po_agent.db.repository import delete_all_runs, list_runs, load_run, save_run
from po_agent.ingest.extractors import IMAGE_EXTENSIONS, SPREADSHEET_EXTENSIONS, get_attachment_paths
from po_agent.ingest.pipeline import extract_all
from po_agent.jira import field_map
from po_agent.jira.client import JiraClient
from po_agent.jira.field_map import build_story_payload

logger = logging.getLogger(__name__)

router = APIRouter()

UPLOADS_DIR = Path("uploads")


def _extract_json_object(text: str) -> str:
    """Extract the JSON object from Claude's raw response text.

    Defensive, for two reasons: PROMPT_DIVISION/PROMPT_STORY_DETAIL instruct
    Claude to return raw JSON with no fences, but models don't always comply;
    and Proxi scrapes Claude.ai's web UI rather than calling a clean API, so
    the raw text can also carry extra UI chrome around the answer (extended
    -thinking "Thought for Ns" summaries, stray icon glyphs, a bare "json"
    language-tag left over from a stripped code fence, etc).

    Strips a markdown fence if present, then falls back to slicing from the
    first "{" to the last "}" in the text to skip any such leftover chrome.
    """
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z]*\n?", "", stripped)
        stripped = re.sub(r"\n?```$", "", stripped)
    stripped = stripped.strip()

    start = stripped.find("{")
    end = stripped.rfind("}")
    if start != -1 and end != -1 and end > start:
        return stripped[start : end + 1]
    return stripped


def _parse_json_response(text: str) -> Any:
    """Parse Claude's JSON response, tolerating common LLM JSON mistakes.

    Tries strict json.loads first. Falls back to json_repair, which
    handles things like literal unescaped quotes embedded inside a string
    value — e.g. Claude naturally quoting a document title or phrase in
    prose ("...the document ("some title.docx") is...") without escaping
    the inner quotes, which strict json.loads rejects outright.

    Raises ValueError (not json.JSONDecodeError) on failure, since a
    repair was attempted rather than a plain parse — callers should catch
    ValueError. If the response is truly unparseable, json_repair's
    best-effort result is more likely to fail the schema-shape checks
    that run right after this than to raise here, which still surfaces a
    clear 502 to the caller either way.
    """
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    try:
        return json_repair.loads(text)
    except Exception as exc:
        raise ValueError(f"Claude's response was not valid JSON: {exc}") from exc


def _coerce_acceptance_criteria(raw_items: list) -> list[str]:
    """Force every element of a parsed acceptance_criteria list into a str.

    UserStory.acceptance_criteria is list[str], but despite
    PROMPT_STORY_DETAIL instructing a flat array of strings, Claude
    occasionally nests a list inside one element instead (e.g. a bullet
    that itself became ["search query"] rather than "search query") —
    seen in practice, not hypothetical. A single malformed element used to
    hard-fail the whole generation via Pydantic's ValidationError; this
    recovers instead of discarding an otherwise-good response over one
    bad element:
      - a nested list is flattened by joining its own elements with ", "
      - anything else non-string (number, bool, dict, ...) is str()'d
      - already-a-string elements pass through untouched
    """
    coerced = []
    for item in raw_items:
        if isinstance(item, str):
            coerced.append(item)
        elif isinstance(item, list):
            coerced.append(", ".join(str(sub_item) for sub_item in item))
        else:
            coerced.append(str(item))
    return coerced


@router.get("/runs")
def list_all_runs() -> list[PipelineState]:
    """List all pipeline runs, most recent first."""
    return list_runs()


class ClearAllRunsResponse(BaseModel):
    deleted: int


@router.delete("/runs")
def clear_all_runs() -> ClearAllRunsResponse:
    """Delete every run — DB record and on-disk uploads/{run_id} directory.

    Local PO Agent history/cache only. Never touches JIRA: publishing is
    a one-way push (see publish_story) that doesn't depend on the run
    record surviving afterward, and this endpoint never calls the JIRA
    client at all — a run whose story was already published stays
    published, this just forgets PO Agent's own local copy of it.

    RunRecord is the only table in this schema (see db/models.py) — no
    separate stories/division tables to cascade, deleting the rows IS
    deleting all of it. db.repository.delete_all_runs does that inside
    one atomic transaction and hands back which run_ids were actually
    removed; only once that's committed does this touch the filesystem,
    so a DB-side failure can never leave an orphaned on-disk directory
    whose row is already gone — the worst a later failure can do is
    leave one run's files behind with no DB row referencing them
    anymore (harmless leftover disk usage, not a dangling reference).
    Each directory removal is best-effort per run_id: one bad/locked
    path is logged and skipped rather than aborting the rest of the
    batch, same pattern as publish_story's attachment/comment steps.
    """
    run_ids = delete_all_runs()

    for run_id in run_ids:
        run_dir = UPLOADS_DIR / run_id
        try:
            shutil.rmtree(run_dir)
        except FileNotFoundError:
            pass
        except OSError as exc:
            logger.warning("Failed to delete uploads directory for run %s: %s", run_id, exc)

    return ClearAllRunsResponse(deleted=len(run_ids))


@router.post("/runs")
def create_run(
    files: list[UploadFile] = File(default=[]),
    pasted_text: str = Form(default=""),
    claude_project_id: str | None = Form(default=None),
) -> PipelineState:
    """Create a new run from uploaded files and/or pasted text.

    Saves any uploaded files to uploads/{run_id}/. Only .txt content gets
    locally text-extracted (ingest.pipeline.extract_all) into
    extracted_requirements, along with pasted_text (if any) as its own
    section — PDF/DOCX/images are not text-extracted at all, they're sent
    to Claude directly as attachments later (see /divide, /stories).
    Lands the run in PENDING_ANALYSIS_REVIEW — extraction here is
    synchronous local file parsing, not an LLM call, so by the time this
    returns there's nothing left to wait on.

    claude_project_id, if the PO already picked a Claude Project before
    uploading, is stored on the run (later steps read it back off
    state.claude_project_id — see divide_run/generate_story_detail) AND
    used right here to seed that project's knowledge base with the
    source documents, so it has them from the start rather than only
    picking them up the first time /divide runs.
    """
    has_files = any(f.filename for f in files)
    if not has_files and not pasted_text.strip():
        raise HTTPException(
            status_code=400, detail="Provide at least one file or some pasted text"
        )

    run_id = str(uuid.uuid4())
    run_dir = UPLOADS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    saved_paths: list[str] = []
    for upload in files:
        if not upload.filename:
            continue
        dest = run_dir / upload.filename
        dest.write_bytes(upload.file.read())
        # Resolve to absolute: Proxi (see agent/proxi_client.py) runs from a
        # different working directory, so a path relative to *this*
        # process's cwd would silently fail to resolve over there.
        saved_paths.append(str(dest.resolve()))

    try:
        combined_text, _attachment_paths = extract_all(saved_paths) if saved_paths else ("", [])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if pasted_text.strip():
        combined_text += f"=== Pasted Text ===\n{pasted_text.strip()}\n\n"

    now = datetime.now(timezone.utc)
    state = PipelineState(
        run_id=run_id,
        status=RunStatus.PENDING_ANALYSIS_REVIEW,
        source_documents=saved_paths,
        extracted_requirements=combined_text,
        claude_project_id=claude_project_id,
        created_at=now,
        updated_at=now,
    )
    save_run(state)

    if claude_project_id and saved_paths:
        # Best-effort: the run itself is already valid and usable even if
        # this fails (the PO can still review/divide/etc — /divide would
        # just re-send the source docs as plain attachments instead of
        # relying on the project's knowledge base), so a failure here is
        # logged, not raised, same as publish_story's own comment/
        # attachment steps after the issue already exists.
        try:
            upload_to_project(claude_project_id, saved_paths)
        except RuntimeError as exc:
            logger.warning(
                "Failed to seed Claude project %s with source documents for run %s: %s",
                claude_project_id,
                run_id,
                exc,
            )

    return state


@router.get("/runs/{run_id}")
def get_run(run_id: str) -> PipelineState:
    """Fetch the full current state of a run."""
    state = load_run(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")
    return state


class RequirementsUpdateRequest(BaseModel):
    """PO-edited extracted requirements text, replacing it wholesale."""

    extracted_requirements: str


@router.put("/runs/{run_id}/requirements")
def update_run_requirements(run_id: str, body: RequirementsUpdateRequest) -> PipelineState:
    """Accept the PO's edited requirements text before division runs.

    Lets the PO fix up or fill in extracted_requirements (e.g. when it's
    empty for a PDF/DOCX-only upload, see ingest.pipeline.extract_all)
    ahead of /divide, without re-uploading files.
    """
    state = load_run(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")

    state.extracted_requirements = body.extracted_requirements
    state.updated_at = datetime.now(timezone.utc)
    save_run(state)

    return state


def _file_type(filename: str) -> str:
    """Classify a filename for the /files listing (pdf/docx/xlsx/image/txt/other)."""
    extension = Path(filename).suffix.lower()
    if extension == ".pdf":
        return "pdf"
    if extension == ".docx":
        return "docx"
    if extension in SPREADSHEET_EXTENSIONS:
        return "xlsx"
    if extension in IMAGE_EXTENSIONS:
        return "image"
    if extension == ".txt":
        return "txt"
    return "other"


@router.get("/runs/{run_id}/files")
def list_run_files(run_id: str) -> list[dict]:
    """List a run's uploaded source files with their static-file URLs.

    URLs point at the StaticFiles mount in main.py (/files -> uploads/),
    so the frontend can render links/previews without duplicating the
    uploads/{run_id}/{filename} path logic itself.
    """
    state = load_run(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")

    files = []
    for path_str in state.source_documents:
        filename = Path(path_str).name
        files.append(
            {
                "filename": filename,
                "url": f"/files/{run_id}/{quote(filename)}",
                "type": _file_type(filename),
            }
        )
    return files


@router.get("/projects")
def get_projects(response: Response) -> list[dict]:
    """Fetch JIRA projects this identity can create issues in, for the
    Publish step's Project picker — see JiraClient.get_projects for why
    that's a create-permission check (mypermissions) rather than a
    project-type filter.

    no-store: this reflects live JIRA permissions, not a static list —
    a browser silently serving a stale cached response here (no
    validators were ever sent, so there's nothing to revalidate against)
    would show stale/incomplete projects with no visible sign anything
    was wrong.
    """
    response.headers["Cache-Control"] = "no-store"
    return JiraClient().get_projects()


@router.get("/projects/{project_key}/publish-fields")
def get_publish_field_availability(project_key: str, response: Response) -> dict:
    """Confirm which Publish-step fields exist for this project's Story
    issue type — called when the PO changes the Project dropdown, so the
    frontend knows which fields to show/hide for that project (see
    JiraClient.get_publish_field_availability).

    no-store: same reasoning as /projects — live JIRA schema, not static.
    """
    response.headers["Cache-Control"] = "no-store"
    return JiraClient().get_publish_field_availability(project_key)


@router.get("/runs/{run_id}/epics")
def get_run_epics(run_id: str) -> list[dict]:
    """Fetch Dubai Justice epics from JIRA and cache them on the run."""
    state = load_run(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")

    epics = JiraClient().get_epics()

    state.epics_available = epics
    save_run(state)

    return epics


@router.get("/epics/search")
def search_epics(q: str = "") -> list[dict]:
    """Type-ahead search for epics across the WHOLE JIRA instance, not just
    SRVPS — backs the Publish step's Epic dropdown now that it needs to
    reach any of the instance's ~3,192 issues. Additive alongside
    /runs/{run_id}/epics (still SRVPS-only, still returns all ~46 in one
    shot) rather than a replacement — nothing about that endpoint changed.

    Not run-scoped, same reasoning as /accounts: results aren't tied to a
    run's own state, and there's nothing here worth caching on one.
    """
    return JiraClient().search_epics(q)


@router.get("/accounts")
def get_accounts(response: Response, project_id: str = field_map.PROJECT_ID) -> list[dict]:
    """Fetch Tempo accounts linked to the given project (default TRKDJP),
    for the Publish step's Account dropdown (see field_map.ACCOUNT_FIELD).
    project_id comes from whatever the PO has picked in the Project
    dropdown — re-fetched whenever that changes, confirmed live to
    generalize cleanly to any project id (TRKDJP/TNOQRL/TRKDN each return
    that project's own correctly-linked account).

    Unlike /runs/{run_id}/epics, not run-scoped or cached on a run: the
    account list isn't part of PipelineState and isn't specific to any one
    run's source documents, same as it isn't specific to any one story —
    it's a fixed-ish list of what the selected JIRA project is authorized
    to bill against.

    no-store: same reasoning as /projects — live Tempo state, not static.
    """
    response.headers["Cache-Control"] = "no-store"
    return JiraClient().get_accounts(project_id)


@router.get("/users/search")
def search_users(field_id: str, q: str = "") -> list[dict]:
    """Type-ahead search for one of the Roles tab's user-picker fields —
    field_id is the customfield_XXXXX being searched for (e.g.
    field_map.FIELD_PRODUCT_OWNER); see JiraClient.search_users for why
    it's required even though it doesn't change the results.
    """
    return JiraClient().search_users(field_id, q)


@router.get("/groups/search")
def search_groups(q: str = "") -> list[dict]:
    """Type-ahead search for the Roles tab's Assigned Group field."""
    return JiraClient().search_groups(q)


class DivisionUpdateRequest(BaseModel):
    """PO-edited story division, fully replacing whatever was auto-generated."""

    story_division: list[StoryDivisionItem]


@router.put("/runs/{run_id}/division")
def update_run_division(run_id: str, body: DivisionUpdateRequest) -> PipelineState:
    """Accept the PO's edited story division and mark it approved."""
    state = load_run(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")

    if not body.story_division:
        raise HTTPException(
            status_code=400, detail="story_division must be non-empty"
        )

    state.story_division = body.story_division
    state.status = RunStatus.DIVISION_APPROVED
    state.updated_at = datetime.now(timezone.utc)
    save_run(state)

    return state


@router.post("/runs/{run_id}/division/{division_item_id}/attachments")
def add_division_item_attachments(
    run_id: str,
    division_item_id: str,
    files: list[UploadFile] = File(default=[]),
) -> PipelineState:
    """Attach supplementary files to one division item.

    Saved separately from the run's main source_documents (under
    uploads/{run_id}/extra/{division_item_id}/, not uploads/{run_id}/) so
    they don't get swept up as "original" files by e.g. /files. Appended
    to the item's extra_attachments, which /stories/{division_item_id}
    combines with source_documents for the Proxi attach call.
    """
    state = load_run(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")

    division_item = next(
        (item for item in state.story_division if item.id == division_item_id), None
    )
    if division_item is None:
        raise HTTPException(
            status_code=404,
            detail=f"Division item {division_item_id!r} not found on run {run_id!r}",
        )

    has_files = any(f.filename for f in files)
    if not has_files:
        raise HTTPException(status_code=400, detail="Provide at least one file")

    extra_dir = UPLOADS_DIR / run_id / "extra" / division_item_id
    extra_dir.mkdir(parents=True, exist_ok=True)

    for upload in files:
        if not upload.filename:
            continue
        dest = extra_dir / upload.filename
        dest.write_bytes(upload.file.read())
        # Resolve to absolute: Proxi (see agent/proxi_client.py) runs from a
        # different working directory, so a path relative to *this*
        # process's cwd would silently fail to resolve over there.
        division_item.extra_attachments.append(str(dest.resolve()))

    state.updated_at = datetime.now(timezone.utc)
    save_run(state)

    return state


@router.delete("/runs/{run_id}/division/{division_item_id}/attachments/{filename}")
def delete_division_item_attachment(
    run_id: str, division_item_id: str, filename: str
) -> PipelineState:
    """Remove one supplementary attachment from a division item.

    Matches by basename (extra_attachments stores absolute paths — see
    add_division_item_attachments — so the frontend, which only knows the
    filename, can't address an entry by its full path). Removes it from
    extra_attachments and deletes the file from disk; a file that's
    already missing on disk (moved/deleted out of band) doesn't fail the
    request — the extra_attachments entry is still removed either way,
    since that's the part that actually matters to the PO.
    """
    state = load_run(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")

    division_item = next(
        (item for item in state.story_division if item.id == division_item_id), None
    )
    if division_item is None:
        raise HTTPException(
            status_code=404,
            detail=f"Division item {division_item_id!r} not found on run {run_id!r}",
        )

    matching_path = next(
        (path for path in division_item.extra_attachments if Path(path).name == filename),
        None,
    )
    if matching_path is None:
        raise HTTPException(
            status_code=404,
            detail=f"Attachment {filename!r} not found on division item {division_item_id!r}",
        )

    division_item.extra_attachments.remove(matching_path)

    try:
        Path(matching_path).unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("Failed to delete attachment file %s: %s", matching_path, exc)

    state.updated_at = datetime.now(timezone.utc)
    save_run(state)

    return state


@router.get("/prompts")
def get_default_prompts() -> dict:
    """Return the current default prompt texts, for the override panel to
    show/pre-fill against. Plain constants — not run-specific."""
    return {"division_prompt": PROMPT_DIVISION, "story_prompt": PROMPT_STORY_DETAIL}


class PromptOverrideRequest(BaseModel):
    """PO-supplied per-run prompt overrides. null clears a field back to
    the default constant (PROMPT_DIVISION / PROMPT_STORY_DETAIL) — this
    never mutates those constants themselves, only this run's own state.
    """

    division_prompt: str | None = None
    story_prompt: str | None = None


@router.put("/runs/{run_id}/prompts")
def update_run_prompts(run_id: str, body: PromptOverrideRequest) -> PipelineState:
    """Set (or clear, via null) this run's custom division/story prompts."""
    state = load_run(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")

    state.custom_division_prompt = body.division_prompt
    state.custom_story_prompt = body.story_prompt
    state.updated_at = datetime.now(timezone.utc)
    save_run(state)

    return state


@router.get("/claude-projects")
def get_claude_projects() -> list[dict]:
    """List the PO's Claude.ai Projects, for the frontend's project picker."""
    try:
        return list_projects()
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


class CreateClaudeProjectRequest(BaseModel):
    name: str
    description: str = ""


class CreateClaudeProjectResponse(BaseModel):
    project_id: str


@router.post("/claude-projects")
def create_claude_project(body: CreateClaudeProjectRequest) -> CreateClaudeProjectResponse:
    """Create a new Claude.ai Project via Proxi and return its id."""
    try:
        project_id = create_project(body.name, body.description)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return CreateClaudeProjectResponse(project_id=project_id)


class RunClaudeProjectRequest(BaseModel):
    project_id: str | None


@router.put("/runs/{run_id}/claude-project")
def update_run_claude_project(run_id: str, body: RunClaudeProjectRequest) -> PipelineState:
    """Set (or clear, via null) which Claude Project this run's /divide and
    /stories calls run inside — see PipelineState.claude_project_id."""
    state = load_run(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")

    state.claude_project_id = body.project_id
    state.updated_at = datetime.now(timezone.utc)
    save_run(state)

    return state


@router.post("/runs/{run_id}/divide")
def divide_run(run_id: str) -> PipelineState:
    """Divide extracted requirements into story stubs via Claude."""
    state = load_run(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")

    attachment_paths = get_attachment_paths(state.source_documents)
    division_prompt = state.custom_division_prompt or PROMPT_DIVISION

    try:
        raw_response = call_claude_via_proxi(
            division_prompt,
            state.extracted_requirements or "",
            attachment_paths,
            project_id=state.claude_project_id,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    cleaned = _extract_json_object(raw_response)

    try:
        parsed = _parse_json_response(cleaned)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    if not isinstance(parsed, dict) or not isinstance(parsed.get("story_division"), list):
        # TEMPORARY: dumping the full, untruncated raw Proxi response (plus
        # what our own cleaning/parsing produced from it) so a real failure
        # can be diagnosed — malformed JSON, extra prose our fence-strip/
        # brace-slice missed, wrong top-level shape, etc. Remove once the
        # large-Arabic-PDF /divide failure is understood.
        logger.error(
            "divide_run: run %s — Claude's response did not match the expected "
            '{"story_division": [...]} schema.\n'
            "----- RAW response from Proxi (untouched) -----\n%s\n"
            "----- After _extract_json_object cleaning -----\n%s\n"
            "----- After JSON parsing -----\n%r",
            run_id,
            raw_response,
            cleaned,
            parsed,
        )
        raise HTTPException(
            status_code=502,
            detail='Claude\'s response did not match the expected {"story_division": [...]} schema',
        )

    try:
        division_items = [
            StoryDivisionItem(id=f"DIV-{i:03d}", **raw_item)
            for i, raw_item in enumerate(parsed["story_division"], start=1)
        ]
    except (ValidationError, TypeError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Claude's story_division items did not match the expected schema: {exc}",
        )

    state.story_division = division_items
    state.status = RunStatus.PENDING_DIVISION_REVIEW
    state.updated_at = datetime.now(timezone.utc)
    save_run(state)

    return state


@router.post("/runs/{run_id}/stories/{division_item_id}")
def generate_story_detail(run_id: str, division_item_id: str) -> PipelineState:
    """Generate full user story detail for one division item via Claude."""
    state = load_run(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")

    division_item = next(
        (item for item in state.story_division if item.id == division_item_id), None
    )
    if division_item is None:
        raise HTTPException(
            status_code=404,
            detail=f"Division item {division_item_id!r} not found on run {run_id!r}",
        )

    if state.status != RunStatus.DIVISION_APPROVED:
        raise HTTPException(
            status_code=400, detail="division must be approved before generating story detail"
        )

    division_item_content = (
        f"Division item:\n"
        f"Title: {division_item.title}\n"
        f"Summary: {division_item.summary}\n"
        f"Source refs: {division_item.source_refs}\n\n"
        f"Original source content:\n{state.extracted_requirements or ''}"
    )

    # Combine the run's original source documents with anything uploaded
    # specifically for this division item (see
    # POST /division/{division_item_id}/attachments), so a regenerate
    # picks up newly-added supplementary files alongside the original
    # context, not just one or the other.
    attachment_paths = get_attachment_paths(
        state.source_documents + division_item.extra_attachments
    )
    story_prompt = state.custom_story_prompt or PROMPT_STORY_DETAIL

    try:
        raw_response = call_claude_via_proxi(
            story_prompt,
            division_item_content,
            attachment_paths,
            project_id=state.claude_project_id,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    cleaned = _extract_json_object(raw_response)

    try:
        parsed = _parse_json_response(cleaned)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    if (
        not isinstance(parsed, dict)
        or not isinstance(parsed.get("summary"), str)
        or not isinstance(parsed.get("description"), str)
        or not isinstance(parsed.get("acceptance_criteria"), list)
        or parsed.get("story_type") not in ("Business", "Technical")
    ):
        raise HTTPException(
            status_code=502,
            detail=(
                "Claude's response did not match the expected "
                '{"summary": str, "description": str, "acceptance_criteria": [str], '
                '"story_type": "Business"|"Technical"} schema'
            ),
        )

    # Regenerating (the PO discards this generation and re-runs it) has to
    # replace the existing story in place, not append a second one for the
    # same division item — this used to always append, so clicking
    # Regenerate silently piled up duplicate stories per item. Reusing the
    # existing story's id (rather than minting a new one) keeps it stable
    # across a regenerate.
    existing_story = next(
        (story for story in state.user_stories if story.source_division_item_id == division_item.id),
        None,
    )
    story_id = existing_story.id if existing_story is not None else f"US-{len(state.user_stories) + 1:03d}"

    try:
        new_story = UserStory(
            id=story_id,
            source_division_item_id=division_item.id,
            summary=parsed["summary"],
            description=parsed["description"],
            acceptance_criteria=_coerce_acceptance_criteria(parsed["acceptance_criteria"]),
            story_type=parsed["story_type"],
        )
    except ValidationError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Claude's story detail did not match the expected schema: {exc}",
        )

    if existing_story is not None:
        state.user_stories = [
            new_story if story.id == existing_story.id else story for story in state.user_stories
        ]
    else:
        state.user_stories.append(new_story)

    state.updated_at = datetime.now(timezone.utc)
    save_run(state)

    return state


class StoryUpdateRequest(BaseModel):
    """PO-edited fields on an already-generated user story.

    Deliberately excludes id/source_division_item_id/summary/epic_key/
    story_points/notes/jira_key — this endpoint is for the fields the
    DIVISION_APPROVED card view lets the PO edit directly (description,
    acceptance criteria, story type), not a full story replacement.
    """

    description: str
    acceptance_criteria: list[str]
    story_type: Literal["Business", "Technical"]


@router.put("/runs/{run_id}/stories/{story_id}")
def update_user_story(run_id: str, story_id: str, body: StoryUpdateRequest) -> PipelineState:
    """Persist the PO's edits to a generated story's description/AC/type."""
    state = load_run(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")

    story = next((s for s in state.user_stories if s.id == story_id), None)
    if story is None:
        raise HTTPException(
            status_code=404, detail=f"Story {story_id!r} not found on run {run_id!r}"
        )

    story.description = body.description
    story.acceptance_criteria = body.acceptance_criteria
    story.story_type = body.story_type
    state.updated_at = datetime.now(timezone.utc)
    save_run(state)

    return state


class PublishStoryRequest(BaseModel):
    """PO-supplied fields for pushing one story to JIRA as a real issue.

    Everything else the issue needs (summary/description/acceptance
    criteria/story_type) already lives on the UserStory itself; this is
    just what only the PO can decide at publish time.
    """

    project_id: str
    epic_key: str
    account_id: str
    product_owner: str
    priority: str | None = None
    story_points: float | None = None
    comment: str | None = None
    functional_area: list[str] | None = None
    product_manager: str | None = None
    delivery_manager: str | None = None
    service_manager: str | None = None
    software_engineer: str | None = None
    quality_engineer: str | None = None
    assigned_group: str | None = None
    owner: str | None = None


class PublishStoryResponse(BaseModel):
    """What the caller needs after a publish: the new issue's key/URL, plus
    how much of the attach-files/add-comment follow-up actually landed."""

    jira_key: str
    jira_url: str
    attachments_uploaded: int
    comment_added: bool


@router.post("/runs/{run_id}/stories/{story_id}/publish")
def publish_story(run_id: str, story_id: str, body: PublishStoryRequest) -> PublishStoryResponse:
    """Create this story as a real JIRA issue, then attach files and comment.

    Issue creation is the one step that has to succeed for this endpoint
    to succeed at all — a failure there raises 502 and nothing else runs.
    The comment and each attachment are each best-effort *after* that: the
    issue already exists by then, so a failure adding a comment or one
    attachment shouldn't make the whole call look like it failed (the PO
    would just retry and get a duplicate issue). attachments_uploaded/
    comment_added in the response report exactly how much of the
    follow-up actually landed, without discarding the successful create.

    Attachments come from this story's *division item's* extra_attachments
    (see StoryDivisionItem.extra_attachments / POST
    /division/{division_item_id}/attachments) — not run.source_documents,
    which were already Claude's context during generation, not meant to be
    dumped onto the created JIRA issue too.
    """
    state = load_run(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id!r} not found")

    story = next((s for s in state.user_stories if s.id == story_id), None)
    if story is None:
        raise HTTPException(
            status_code=404, detail=f"Story {story_id!r} not found on run {run_id!r}"
        )

    payload = build_story_payload(
        summary=story.summary,
        description=story.description,
        acceptance_criteria=story.acceptance_criteria,
        project_id=body.project_id,
        epic_key=body.epic_key,
        account_id=body.account_id,
        product_owner=body.product_owner,
        story_type=story.story_type,
        priority=body.priority,
        story_points=body.story_points,
        functional_area=body.functional_area,
        product_manager=body.product_manager,
        delivery_manager=body.delivery_manager,
        service_manager=body.service_manager,
        software_engineer=body.software_engineer,
        quality_engineer=body.quality_engineer,
        assigned_group=body.assigned_group,
        owner=body.owner,
    )

    client = JiraClient()
    try:
        created = client.create_issue(payload)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Failed to create JIRA issue: {exc}") from exc

    jira_key = created["key"]

    comment_added = False
    if body.comment:
        try:
            client.add_comment(jira_key, body.comment)
            comment_added = True
        except requests.RequestException as exc:
            logger.warning("Failed to add comment to %s: %s", jira_key, exc)

    division_item = next(
        (item for item in state.story_division if item.id == story.source_division_item_id),
        None,
    )
    extra_attachments = division_item.extra_attachments if division_item is not None else []

    attachments_uploaded = 0
    for filepath in extra_attachments:
        try:
            client.add_attachment(jira_key, filepath)
            attachments_uploaded += 1
        except (requests.RequestException, OSError) as exc:
            # OSError covers a stale extra_attachments entry pointing at a
            # file that's since been moved/deleted off uploads/ — one bad
            # path shouldn't abort the rest of the batch.
            logger.warning("Failed to attach %s to %s: %s", filepath, jira_key, exc)

    # jira_key on the story is the durable record of the publish — the
    # counts/URL below are only ever in the response, not persisted.
    story.jira_key = jira_key
    state.updated_at = datetime.now(timezone.utc)
    save_run(state)

    return PublishStoryResponse(
        jira_key=jira_key,
        jira_url=f"{client.base_url}/browse/{jira_key}",
        attachments_uploaded=attachments_uploaded,
        comment_added=comment_added,
    )
