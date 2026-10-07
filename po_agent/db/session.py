"""SQLite connection setup.

Configures the SQLModel/SQLAlchemy engine used to talk to the local
SQLite database, plus init_db() to create tables and get_session() to
hand out sessions (usable as a plain context manager or as a FastAPI
dependency).
"""

from collections.abc import Generator

from sqlalchemy import inspect, text
from sqlmodel import Session, SQLModel, create_engine

DATABASE_URL = "sqlite:///po_agent.db"

engine = create_engine(DATABASE_URL, echo=False, connect_args={"check_same_thread": False})


def init_db() -> None:
    """Create all tables that don't exist yet, then patch existing ones.

    create_all only creates missing tables — it never alters a table that
    already exists, so a column added to RunRecord after the very first
    run (story_division before this, custom_division_prompt/
    custom_story_prompt/claude_project_id since) needs its own explicit
    ALTER TABLE here or it silently never appears on a pre-existing
    po_agent.db. No real migration framework in this project (single
    SQLite file, no alembic) — this is a lightweight, idempotent stand-in:
    only runs the ALTER when the column is actually missing, safe to call
    on every startup.
    """
    SQLModel.metadata.create_all(engine)

    inspector = inspect(engine)
    if "runrecord" not in inspector.get_table_names():
        return
    existing_columns = {col["name"] for col in inspector.get_columns("runrecord")}
    missing_text_columns = {
        "custom_division_prompt",
        "custom_story_prompt",
        "claude_project_id",
    } - existing_columns
    if missing_text_columns:
        with engine.begin() as connection:
            for column in missing_text_columns:
                connection.execute(text(f"ALTER TABLE runrecord ADD COLUMN {column} VARCHAR"))


def get_session() -> Generator[Session, None, None]:
    """Yield a SQLModel session. Usable as a FastAPI dependency."""
    with Session(engine) as session:
        yield session
