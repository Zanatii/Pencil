"""Live integration test for per-division-item extra_attachments.

Not part of the app. Exercises the *running* dev server (uvicorn on
:8010, must already be up) and the real Proxi bridge (:4001, must
already be up and pointed at a logged-in Claude.ai tab) end to end:

1. Create a run from a small source doc.
2. Divide it into story-division items.
3. Approve the division (so /stories/{id} is allowed to run).
4. Upload a small supplementary .docx to one division item via the new
   POST /runs/{run_id}/division/{division_item_id}/attachments endpoint,
   containing a one-off marker string that appears nowhere else.
5. Confirm the returned run has that path recorded in the item's
   extra_attachments.
6. Regenerate story detail for that item and confirm the generated
   story's text reflects the marker content -- i.e. it was actually
   attached to the Proxi call, not just recorded on the item.
"""

import sys
import uuid
from pathlib import Path

import requests
from docx import Document

BASE_URL = "http://127.0.0.1:8010"
MARKER = f"ZXQ-MARKER-{uuid.uuid4().hex[:8]}"

session = requests.Session()


def check(condition: bool, message: str) -> None:
    if not condition:
        print(f"FAIL: {message}")
        sys.exit(1)
    print(f"OK: {message}")


# 1. Create a run from the existing sample.txt fixture.
fixtures_dir = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
with open(fixtures_dir / "sample.txt", "rb") as f:
    resp = session.post(f"{BASE_URL}/runs", files={"files": ("sample.txt", f, "text/plain")})
check(resp.status_code == 200, f"create run ({resp.status_code}): {resp.text[:300]}")
run = resp.json()
run_id = run["run_id"]
print(f"run_id={run_id}")

# 2. Divide into story-division items (real Proxi/Claude call).
resp = session.post(f"{BASE_URL}/runs/{run_id}/divide")
check(resp.status_code == 200, f"divide run ({resp.status_code}): {resp.text[:500]}")
run = resp.json()
check(len(run["story_division"]) > 0, "story_division is non-empty")
division_item_id = run["story_division"][0]["id"]
print(f"division_item_id={division_item_id}")

# 3. Approve the division as-is so /stories/{id} is allowed to run.
resp = session.put(
    f"{BASE_URL}/runs/{run_id}/division", json={"story_division": run["story_division"]}
)
check(resp.status_code == 200, f"approve division ({resp.status_code}): {resp.text[:300]}")
check(resp.json()["status"] == "DIVISION_APPROVED", "run status is DIVISION_APPROVED")

# 4. Upload a small supplementary .docx with a unique marker string.
extra_doc_path = Path(fixtures_dir / "extra_attachment_test.docx")
doc = Document()
doc.add_paragraph(
    f"Supplementary requirement: the confirmation screen must display the "
    f"code {MARKER} in the footer."
)
doc.save(extra_doc_path)

with open(extra_doc_path, "rb") as f:
    resp = session.post(
        f"{BASE_URL}/runs/{run_id}/division/{division_item_id}/attachments",
        files={"files": ("extra_attachment_test.docx", f, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
    )
check(resp.status_code == 200, f"upload extra attachment ({resp.status_code}): {resp.text[:300]}")
run = resp.json()

# 5. Confirm it's recorded in extra_attachments.
item = next(i for i in run["story_division"] if i["id"] == division_item_id)
check(len(item["extra_attachments"]) == 1, "extra_attachments has exactly one entry")
uploaded_path = Path(item["extra_attachments"][0])
check(uploaded_path.is_absolute(), "stored path is absolute")
check(uploaded_path.is_file(), f"stored path exists on disk: {uploaded_path}")
check(
    str(uploaded_path).replace("\\", "/") == str(extra_doc_path.resolve()).replace("\\", "/")
    or uploaded_path.name == "extra_attachment_test.docx",
    "stored path points at the uploaded file",
)

# 6. Regenerate story detail for that item (real Proxi/Claude call) and
# confirm the marker made it into the generated story -- proof the extra
# attachment was actually included in the attach_paths sent to Proxi.
resp = session.post(f"{BASE_URL}/runs/{run_id}/stories/{division_item_id}")
check(resp.status_code == 200, f"generate story detail ({resp.status_code}): {resp.text[:500]}")
run = resp.json()
story = next(s for s in run["user_stories"] if s["source_division_item_id"] == division_item_id)
story_text = " ".join(
    [story["summary"], story["description"], *story["acceptance_criteria"]]
)
print("--- generated story text ---")
print(story_text)
print("--- end generated story text ---")
check(MARKER in story_text, f"generated story references marker {MARKER!r} from the extra attachment")

print("ALL OK")
