"""Top-level ingestion entrypoint: route uploaded files to extractors."""

from pathlib import Path

from po_agent.ingest.extractors import extract_txt, get_attachment_paths

TEXT_EXTRACTORS = {
    ".txt": extract_txt,
}


def extract_all(filepaths: list[str]) -> tuple[str, list[str]]:
    """Extract .txt content and identify everything else as an attachment.

    PDF/DOCX/images are no longer locally text-extracted at all — only
    .txt files are. Routes each filepath by extension. Returns
    (combined_text, attachment_paths):
      - combined_text: extracted .txt content concatenated, with a header
        per file: "=== FILENAME ===\n{content}\n\n"
      - attachment_paths: everything that isn't .txt (PDF, DOCX, images),
        to be sent to Claude directly later as attachments (not
        pre-processed here).

    Raises ValueError for any unsupported file extension.
    """
    # Resolve to absolute here too, defensively — callers other than the
    # /runs POST endpoint may hand in relative paths, and both the
    # combined_text extraction below and the returned attachment_paths
    # need to work from Proxi's working directory, not just this
    # process's.
    filepaths = [str(Path(filepath).resolve()) for filepath in filepaths]

    attachment_paths = get_attachment_paths(filepaths)
    attachment_path_set = set(attachment_paths)

    combined_parts = []
    for filepath in filepaths:
        if filepath in attachment_path_set:
            continue

        extension = Path(filepath).suffix.lower()
        extractor = TEXT_EXTRACTORS.get(extension)
        if extractor is None:
            raise ValueError(f"Unsupported file extension: {extension!r} ({filepath})")

        content = extractor(filepath)
        filename = Path(filepath).name
        combined_parts.append(f"=== {filename} ===\n{content}\n\n")

    combined_text = "".join(combined_parts)
    return combined_text, attachment_paths
