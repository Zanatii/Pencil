"""Pipeline state schema.

Defines the pydantic model(s) representing the state of a PO Agent
pipeline run as it moves through ingestion, extraction, review, and
JIRA write-back steps.
"""

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel


class RunStatus(str, Enum):
    """Lifecycle status of a pipeline run."""

    EXTRACTING = "EXTRACTING"
    PENDING_ANALYSIS_REVIEW = "PENDING_ANALYSIS_REVIEW"
    PENDING_DIVISION_REVIEW = "PENDING_DIVISION_REVIEW"
    DIVISION_APPROVED = "DIVISION_APPROVED"
    GENERATING_STORIES = "GENERATING_STORIES"
    PENDING_STORY_REVIEW = "PENDING_STORY_REVIEW"
    WRITING_JIRA = "WRITING_JIRA"
    DONE = "DONE"
    FAILED = "FAILED"


class StoryDivisionItem(BaseModel):
    """One item in the PO-edited breakdown of extracted requirements.

    Produced (auto-generated, then PO-edited) before full user stories are
    generated: a lightweight title/summary/source-reference stub per
    intended story, not yet fleshed out with acceptance criteria etc.
    """

    id: str
    """Stable id for this division item, e.g. "DIV-001".

    Sequential per run, generated when division items are created/set.
    Lets the UI reference a specific item (merge/delete/edit) without
    matching on title text.
    """

    title: str
    summary: str
    source_refs: list[str] = []
    """References back into the source documents (e.g. section/page markers)."""

    extra_attachments: list[str] = []
    """Absolute paths to files uploaded specifically for this division item.

    Added via POST /runs/{run_id}/division/{division_item_id}/attachments,
    same absolute-path pattern as PipelineState.source_documents. Included
    alongside the run's source_documents when (re)generating this item's
    story detail, so a PO can supplement/correct context for one item
    without re-uploading it for the whole run.
    """


class UserStory(BaseModel):
    """A single generated user story, pending or written to JIRA.

    Field comments note the JIRA field each maps to (see
    po_agent/jira/field_map.py for the actual field keys/ids).
    """

    id: str
    """Temporary id assigned during generation, e.g. "US-001"."""

    source_division_item_id: str | None = None
    """Id of the StoryDivisionItem this story was generated from, if any.

    Distinct namespace from `id` (e.g. "DIV-001" vs "US-001") so this is
    purely a traceability link, not a shared identifier.
    """

    summary: str
    """Maps to JIRA "summary"."""

    description: str
    """Maps to JIRA "description"."""

    acceptance_criteria: list[str]
    """Bullet lines in house style: "As a User, I want X so that Y".

    Maps to customfield_11200 as newline-joined text.
    """

    epic_key: str | None = None
    """JIRA key of an EXISTING epic, selected not generated.

    Maps to customfield_10009.
    """

    story_type: Literal["Business", "Technical"] = "Business"
    """Maps to customfield_13636."""

    story_points: float | None = None
    """Optional. Maps to customfield_10005."""

    notes: str | None = None
    """Flagged ambiguities/contradictions. Not written to JIRA."""

    jira_key: str | None = None
    """Filled in after write."""


class PipelineState(BaseModel):
    """Full state of a single pipeline run."""

    run_id: str
    status: RunStatus
    source_documents: list[str]
    extracted_requirements: str | None = None
    epics_available: list[dict] = []
    """Fetched from JIRA: [{"key": ..., "name": ...}].

    Populated before story generation so LLM/PO can pick from real
    epics.
    """
    story_division: list[StoryDivisionItem] = []
    """PO-approved breakdown of extracted requirements into story stubs.

    Set via PUT /runs/{run_id}/division, fully replacing whatever was
    auto-generated. Drives the subsequent full story generation step.
    """
    user_stories: list[UserStory] = []
    contradictions_flagged: list[str] = []
    error_message: str | None = None
    custom_division_prompt: str | None = None
    """PO override for PROMPT_DIVISION (agent/prompts/division.py), this run
    only. Set/cleared via PUT /runs/{run_id}/prompts; null means /divide
    falls back to the default constant. Never mutates the constant itself.
    """
    custom_story_prompt: str | None = None
    """PO override for PROMPT_STORY_DETAIL (agent/prompts/story_detail.py),
    this run only. Set/cleared via PUT /runs/{run_id}/prompts; null means
    /stories/{division_item_id} falls back to the default constant. Never
    mutates the constant itself.
    """
    claude_project_id: str | None = None
    """The Claude.ai Project (see agent/proxi_client.py's list_projects/
    create_project) this run's /divide and /stories calls should run
    inside, if the PO picked one. Set at run creation (POST /runs) or
    later via PUT /runs/{run_id}/claude-project; null means those calls
    use Proxi's plain (non-project) flow, same as before this field
    existed.
    """
    created_at: datetime
    updated_at: datetime
