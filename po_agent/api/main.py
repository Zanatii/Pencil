"""FastAPI app entrypoint.

Creates the FastAPI application instance, wires up routers/middleware,
and exposes a basic health check endpoint. Run with:

    uvicorn po_agent.api.main:app --reload --port 8010

(port also documented in .env / .env.example as PORT — informational
only, since uvicorn is started via the CLI, not programmatically, so
nothing here actually reads that variable)
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from po_agent.api.routes import router
from po_agent.db.session import init_db


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Initialize the database on startup."""
    init_db()
    yield


app = FastAPI(title="PO Agent", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    # Vite dev server. The ui/ frontend calls this API's absolute URL
    # directly (see ui/src/api/client.ts), so this is a real cross-origin
    # request, not same-origin — CORS is needed, not just a dev proxy.
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# StaticFiles requires the directory to exist at mount time — create it
# eagerly so a fresh checkout with no runs yet doesn't crash on startup.
Path("uploads").mkdir(exist_ok=True)
app.mount("/files", StaticFiles(directory="uploads"), name="files")

app.include_router(router)


@app.get("/health")
def health() -> dict:
    """Basic liveness check."""
    return {"status": "ok"}
