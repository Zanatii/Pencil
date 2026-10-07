"""SQLite models for run/step state.

RunRecord is the persisted form of core.state.PipelineState. This is
SQLite, not Postgres, so list/dict fields are stored as JSON strings
rather than in separate tables — kept simple on purpose.
"""

from datetime import datetime

from sqlmodel import Field, SQLModel


class RunRecord(SQLModel, table=True):
    """Persisted row for a single pipeline run."""

    run_id: str = Field(primary_key=True)
    status: str
    source_documents: str
    """JSON-serialized list[str]."""

    extracted_requirements: str | None = None

    epics_available: str = "[]"
    """JSON-serialized list[dict]."""

    story_division: str = "[]"
    """JSON-serialized list of StoryDivisionItem dicts."""

    user_stories: str = "[]"
    """JSON-serialized list of UserStory dicts."""

    contradictions_flagged: str = "[]"
    """JSON-serialized list[str]."""

    error_message: str | None = None
    custom_division_prompt: str | None = None
    custom_story_prompt: str | None = None
    claude_project_id: str | None = None
    created_at: datetime
    updated_at: datetime
