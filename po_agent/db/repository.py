"""Persistence for PipelineState, backed by the RunRecord table.

Handles JSON (de)serialization of PipelineState's list/dict fields so
callers only ever deal in PipelineState, never RunRecord directly.
"""

import json

from sqlmodel import Session, select

from po_agent.core.state import PipelineState, StoryDivisionItem, UserStory
from po_agent.db.models import RunRecord
from po_agent.db.session import engine


def _to_record(state: PipelineState) -> RunRecord:
    return RunRecord(
        run_id=state.run_id,
        status=state.status.value,
        source_documents=json.dumps(state.source_documents),
        extracted_requirements=state.extracted_requirements,
        epics_available=json.dumps(state.epics_available),
        story_division=json.dumps([item.model_dump() for item in state.story_division]),
        user_stories=json.dumps([story.model_dump() for story in state.user_stories]),
        contradictions_flagged=json.dumps(state.contradictions_flagged),
        error_message=state.error_message,
        custom_division_prompt=state.custom_division_prompt,
        custom_story_prompt=state.custom_story_prompt,
        claude_project_id=state.claude_project_id,
        created_at=state.created_at,
        updated_at=state.updated_at,
    )


def _to_state(record: RunRecord) -> PipelineState:
    return PipelineState(
        run_id=record.run_id,
        status=record.status,
        source_documents=json.loads(record.source_documents),
        extracted_requirements=record.extracted_requirements,
        epics_available=json.loads(record.epics_available),
        story_division=[
            StoryDivisionItem(**item) for item in json.loads(record.story_division)
        ],
        user_stories=[UserStory(**story) for story in json.loads(record.user_stories)],
        contradictions_flagged=json.loads(record.contradictions_flagged),
        error_message=record.error_message,
        custom_division_prompt=record.custom_division_prompt,
        custom_story_prompt=record.custom_story_prompt,
        claude_project_id=record.claude_project_id,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def save_run(state: PipelineState) -> None:
    """Upsert a PipelineState into the RunRecord table."""
    record = _to_record(state)
    with Session(engine) as session:
        existing = session.get(RunRecord, record.run_id)
        if existing is not None:
            record_data = record.model_dump(exclude={"run_id"})
            for key, value in record_data.items():
                setattr(existing, key, value)
            session.add(existing)
        else:
            session.add(record)
        session.commit()


def load_run(run_id: str) -> PipelineState | None:
    """Load a RunRecord by id and deserialize it back into a PipelineState."""
    with Session(engine) as session:
        record = session.get(RunRecord, run_id)
        if record is None:
            return None
        return _to_state(record)


def list_runs() -> list[PipelineState]:
    """Return all runs, most recent first (by updated_at desc)."""
    with Session(engine) as session:
        records = session.exec(
            select(RunRecord).order_by(RunRecord.updated_at.desc())
        ).all()
        return [_to_state(record) for record in records]


def delete_all_runs() -> list[str]:
    """Delete every RunRecord row and return the run_ids that were deleted.

    RunRecord is the only table in this schema — story_division/
    user_stories/etc. are JSON blobs on the row itself (see db/models.py),
    not separate tables, so there's nothing to cascade: deleting these
    rows IS deleting all of it.

    Atomic: everything happens inside one Session/one commit(), so a
    failure partway through — an individual delete raising, or the
    commit itself failing — rolls back the whole transaction rather than
    leaving some rows gone and others not. Returning the run_ids (not
    just a count) is deliberate: the caller (routes.py's DELETE /runs)
    needs them to remove each run's uploads/{run_id} directory on disk
    afterward, and does that AFTER this commits successfully — so a
    failure here never leaves an on-disk directory whose DB row is
    already gone (a dangling reference nothing in the app could recover
    from), only ever the reverse (a DB row cleanly gone, its files
    orphaned on disk) if a later file-delete step fails instead.
    """
    with Session(engine) as session:
        records = session.exec(select(RunRecord)).all()
        run_ids = [record.run_id for record in records]
        for record in records:
            session.delete(record)
        session.commit()
    return run_ids
