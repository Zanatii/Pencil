"""Per-format document extraction functions.

extract_txt is the only extractor actually used by ingest.pipeline.extract_all
now — PDF/DOCX are no longer locally text-extracted at all; they're sent to
Claude directly as attachments instead, same as images and spreadsheets
(.xlsx/.xls). extract_pdf/extract_docx are kept here (unused by the
pipeline) in case local text extraction is wanted again later.

get_image_paths/get_attachment_paths are not extraction: they just identify
which uploaded files should be routed to Claude directly as attachments
(vision/document input) rather than being text-extracted.
"""

from pathlib import Path

from docx import Document
from pypdf import PdfReader

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
SPREADSHEET_EXTENSIONS = {".xlsx", ".xls"}
ATTACHMENT_EXTENSIONS = {".pdf", ".docx", *IMAGE_EXTENSIONS, *SPREADSHEET_EXTENSIONS}
"""Everything except .txt: sent to Claude as attachments, not text-extracted."""


def extract_pdf(filepath: str) -> str:
    """Extract text from all pages of a PDF, joined with a page-break marker."""
    reader = PdfReader(filepath)
    pages = [page.extract_text() or "" for page in reader.pages]
    return "\n\n---PAGE BREAK---\n\n".join(pages)


def extract_docx(filepath: str) -> str:
    """Extract all paragraph text from a .docx file, preserving paragraph breaks."""
    document = Document(filepath)
    paragraphs = [paragraph.text for paragraph in document.paragraphs]
    return "\n".join(paragraphs)


def extract_txt(filepath: str) -> str:
    """Read plain text, assuming UTF-8 and falling back to latin-1."""
    path = Path(filepath)
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1")


def get_image_paths(filepaths: list[str]) -> list[str]:
    """Return the subset of filepaths that are images.

    Kept for callers that specifically want just images; ingest.pipeline
    and the API routes use the broader get_attachment_paths now.
    """
    return [
        filepath
        for filepath in filepaths
        if Path(filepath).suffix.lower() in IMAGE_EXTENSIONS
    ]


def get_attachment_paths(filepaths: list[str]) -> list[str]:
    """Return the subset of filepaths sent to Claude as attachments.

    That's everything except .txt: PDFs, DOCX files, images, and
    spreadsheets (.xlsx/.xls). Only .txt content gets local text
    extraction; everything else is handed to Claude directly (via Proxi)
    as an attachment.
    """
    return [
        filepath
        for filepath in filepaths
        if Path(filepath).suffix.lower() in ATTACHMENT_EXTENSIONS
    ]
