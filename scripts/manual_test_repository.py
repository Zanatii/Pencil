"""Throwaway manual test for db/repository.py. Not part of the app."""

from datetime import datetime

from po_agent.core.state import PipelineState, RunStatus, UserStory
from po_agent.db.repository import list_runs, load_run, save_run
from po_agent.db.session import init_db

init_db()

now = datetime(2026, 8, 12, 10, 0, 0)

original = PipelineState(
    run_id="test-run-001",
    status=RunStatus.PENDING_STORY_REVIEW,
    source_documents=["tests/fixtures/sample.txt"],
    extracted_requirements="Some extracted requirements text.",
    epics_available=[{"key": "TRKDJP-1", "name": "Sample Epic"}],
    user_stories=[
        UserStory(
            id="US-001",
            summary="Sample story",
            description="Sample description",
            acceptance_criteria=["As a User, I want X so that Y"],
            epic_key="TRKDJP-1",
            story_type="Business",
            story_points=3.0,
            notes="Flagged ambiguity",
            jira_key=None,
        )
    ],
    contradictions_flagged=["Requirement A conflicts with Requirement B"],
    error_message=None,
    created_at=now,
    updated_at=now,
)

save_run(original)
loaded = load_run("test-run-001")

assert loaded is not None, "load_run returned None"
assert loaded == original, f"Mismatch:\n  original={original}\n  loaded={loaded}"

runs = list_runs()
assert any(run.run_id == "test-run-001" for run in runs), "list_runs did not include saved run"

print("OK")
