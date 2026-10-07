"""JIRA REST API client — read (epics) and write (create issue,
attachments, comments).

Auth is read from .env (JIRA_URL, JIRA_AUTH_TYPE, and the matching
credential). This instance is Jira Server/Data Center and uses a
Personal Access Token as a Bearer header (JIRA_AUTH_TYPE=bearer), per
earlier discovery — basic auth with JIRA_EMAIL is kept as a fallback
in case that ever changes.
"""

import logging
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

from po_agent.jira import field_map

logger = logging.getLogger(__name__)

load_dotenv()

DEFAULT_MAX_RESULTS = 200

EPIC_SEARCH_MIN_QUERY_LENGTH = 2
EPIC_SEARCH_MAX_RESULTS = 50

# Same floor as EPIC_SEARCH_MIN_QUERY_LENGTH, for the same reason — a
# user/group picker search hits every user or group in the instance, not
# just this engagement's, so a stray keystroke shouldn't fire one.
PICKER_MIN_QUERY_LENGTH = 2

# get_projects() checks CREATE_ISSUE permission per project via
# mypermissions — confirmed live to match JIRA's own Create Issue dialog
# exactly (havePermission=True for TRKDJP/SDIMD/SDERES/SRVSLM,
# havePermission=False for TRKDC/SDGRC/PNREV, matching every prior 400-vs-
# 200 createmeta finding). No project type (software vs service-desk) is
# involved — SRVSLM (has create access, no Story issue type) still shows
# up here and gets excluded downstream instead, by
# get_publish_field_availability once actually selected. There's no bulk
# equivalent on this instance (confirmed: comma-separated projectKey
# 404s, and the Cloud-only bulk /permissions/project endpoint 404s here
# too) — one mypermissions call per project, so results are cached for
# PROJECT_PERMISSION_CACHE_TTL_SECONDS (permissions don't change
# minute-to-minute) and fetched concurrently via a thread pool on a cache
# miss, rather than ~88 sequential round trips.
PROJECT_PERMISSION_CACHE_TTL_SECONDS = 1800
_project_permission_cache: dict[str, tuple[bool, float]] = {}
_PERMISSION_CHECK_MAX_WORKERS = 10

# A JIRA issue key: one or more letters/digits (project key, always
# starting with a letter) then "-" then the issue number, e.g. "SRVPS-80".
# Used to detect when a search query is (or looks like) a specific key so
# it can be resolved by direct lookup — JQL's summary~ text search doesn't
# index issue keys at all, so a PO who already knows the key couldn't
# otherwise type it to jump straight to that epic.
_ISSUE_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*-\d+$")

# The Publish step's known fields, keyed by the same names the frontend's
# Fields/Roles tabs use — get_publish_field_availability's single source
# of truth for which customfield_XXXXX (or, for priority, native field) to
# check presence of per project. Confirmed live across TRKDJP/TNOQRL/
# TRKDN that where a field exists its id/schema/shape is identical, but
# existence itself isn't guaranteed (SRVSLM and every service-desk project
# checked lack a Story issue type entirely; TNOQRL lacks assignee/
# fixVersions even where Story does exist) — so this drives a live
# per-project presence check rather than being assumed to apply everywhere.
_KNOWN_STORY_FIELD_IDS = {
    "epic_link": field_map.FIELD_EPIC_LINK,
    "account": field_map.ACCOUNT_FIELD,
    "functional_area": field_map.FIELD_FUNCTIONAL_AREA,
    "priority": "priority",
    "story_points": field_map.FIELD_STORY_POINTS,
    "sprint": field_map.FIELD_SPRINT,
    "product_manager": field_map.FIELD_PRODUCT_MANAGER,
    "product_owner": field_map.FIELD_PRODUCT_OWNER,
    "delivery_manager": field_map.FIELD_DELIVERY_MANAGER,
    "service_manager": field_map.FIELD_SERVICE_MANAGER,
    "software_engineer": field_map.FIELD_SOFTWARE_ENGINEER,
    "quality_engineer": field_map.FIELD_QUALITY_ENGINEER,
    "assigned_group": field_map.FIELD_ASSIGNED_GROUP,
    "owner": field_map.FIELD_OWNER,
}


class JiraClient:
    """Thin wrapper around the JIRA REST API."""

    def __init__(self) -> None:
        self.base_url = os.environ["JIRA_URL"].rstrip("/")
        self.auth_type = os.environ.get("JIRA_AUTH_TYPE", "bearer").lower()
        self.token = os.environ["JIRA_API_TOKEN"]

        self.session = requests.Session()
        if self.auth_type == "bearer":
            self.session.headers["Authorization"] = f"Bearer {self.token}"
        elif self.auth_type == "basic":
            email = os.environ["JIRA_EMAIL"]
            self.session.auth = (email, self.token)
        else:
            raise ValueError(f"Unsupported JIRA_AUTH_TYPE: {self.auth_type!r}")

    def _has_create_issue_permission(self, project_key: str) -> bool:
        """CREATE_ISSUE permission for one project, cached — see the
        _project_permission_cache block comment above for why (no bulk
        permission-check endpoint exists on this instance).
        """
        cached = _project_permission_cache.get(project_key)
        now = time.monotonic()
        if cached is not None and now - cached[1] < PROJECT_PERMISSION_CACHE_TTL_SECONDS:
            return cached[0]

        try:
            response = self.session.get(
                f"{self.base_url}/rest/api/2/mypermissions",
                params={"projectKey": project_key, "permissions": "CREATE_ISSUE"},
                timeout=15,
            )
            response.raise_for_status()
            have_permission = bool(
                response.json().get("permissions", {}).get("CREATE_ISSUE", {}).get("havePermission")
            )
        except requests.RequestException:
            # Same "don't let one bad project break the whole list" reasoning
            # as get_epics'/create_issue's other best-effort spots — treat an
            # unexpected failure as "no access" rather than raising and
            # failing the entire project list over one project.
            have_permission = False

        _project_permission_cache[project_key] = (have_permission, now)
        return have_permission

    def get_projects(self) -> list[dict]:
        """Return [{"id": ..., "key": ..., "name": ...}] for every project
        this identity can actually create issues in — the Publish step's
        Project picker, matching JIRA's own Create Issue dialog exactly
        (confirmed live: TRKDJP/SDIMD/SDERES/SRVSLM all havePermission=True,
        TRKDC/SDGRC/PNREV all False — the same split already seen via
        createmeta 400s in earlier testing, and SDIMD/SDERES specifically
        matching the screenshot of JIRA's own dropdown for this identity).

        Deliberately NOT filtered by project type (software vs
        service-desk) — that was the previous, wrong heuristic; create
        permission is the actual criterion JIRA itself uses. A project
        with access but no "Story" issue type (SRVSLM) still shows up
        here and gets excluded downstream instead, once actually selected
        — see get_publish_field_availability, unchanged by this.

        No bulk permission-check exists on this instance (confirmed:
        comma-separated projectKey 404s; the Cloud-only bulk
        /permissions/project endpoint also 404s here) — checks run
        concurrently via a thread pool on a cache miss instead of ~90
        sequential round trips, and are cached per project for
        PROJECT_PERMISSION_CACHE_TTL_SECONDS afterward.
        """
        response = self.session.get(f"{self.base_url}/rest/api/2/project", timeout=30)
        response.raise_for_status()
        all_projects = response.json()

        with ThreadPoolExecutor(max_workers=_PERMISSION_CHECK_MAX_WORKERS) as executor:
            has_permission = list(
                executor.map(self._has_create_issue_permission, (p["key"] for p in all_projects))
            )

        return [
            {"id": project["id"], "key": project["key"], "name": project["name"]}
            for project, allowed in zip(all_projects, has_permission)
            if allowed
        ]

    def get_epics(self, project_key: str = field_map.EPIC_PROJECT_KEY) -> list[dict]:
        """Return [{"key": ..., "name": ...}] for every epic in SRVPS.

        Defaults to field_map.EPIC_PROJECT_KEY (SRVPS) — epics for this
        engagement live in the shared SRVPS portfolio project, not in
        TRKDJP. Deliberately unfiltered beyond issuetype=Epic: SRVPS holds
        epics for multiple engagements (Dubai Justice Platform, Dubai
        Courts - Managed Services, Zajel, ...), and the PO wants full
        visibility across all of them here rather than a pre-scoped
        subset — an earlier summary-text filter ("Dubai Justice") both
        silently dropped real Dubai Justice Platform epics whose summary
        didn't happen to contain that phrase (e.g. SRVPS-80, 76, 45) and
        let in at least one from a different account whose summary did
        (SRVPS-33), so it was removed rather than replaced with a
        (similarly fragile) account-based filter. "key" is the canonical
        identifier; "name" (the "summary" field) can duplicate across
        epics (e.g. SRVPS-33 and SRVPS-47 share a summary), so don't rely
        on it for uniqueness.

        Pages through startAt/maxResults (DEFAULT_MAX_RESULTS per page)
        until every matching issue has been fetched — SRVPS currently has
        46, comfortably under one page, but there's no guaranteed cap on
        how many epics this project ends up with, so a single-page fetch
        would silently start dropping results once it's crossed.
        """
        url = f"{self.base_url}/rest/api/2/search"
        jql = f"project={project_key} AND issuetype=Epic"

        issues: list[dict] = []
        start_at = 0
        while True:
            params = {
                "jql": jql,
                "fields": "summary,key",
                "maxResults": DEFAULT_MAX_RESULTS,
                "startAt": start_at,
            }
            response = self.session.get(url, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()

            page = data.get("issues", [])
            issues.extend(page)
            start_at += len(page)
            if not page or start_at >= data.get("total", 0):
                break

        return [
            {"key": issue["key"], "name": issue["fields"]["summary"]} for issue in issues
        ]

    def search_epics(self, query: str) -> list[dict]:
        """Type-ahead search for epics across the WHOLE instance (no
        project scope) — unlike get_epics, which is deliberately only
        SRVPS. Backs the Publish step's Epic dropdown now that it needs to
        reach any of the instance's ~3,192 issues, not just SRVPS's ~46,
        which ruled out fetching everything upfront.

        Returns [] for a query shorter than EPIC_SEARCH_MIN_QUERY_LENGTH —
        callers (routes.py) are expected to debounce keystrokes on their
        end too, but this is the hard floor that keeps a single stray
        keystroke from firing an unscoped instance-wide JQL query.

        Two results are merged, exact-key match first:
        1. If `query` itself looks like a full issue key (e.g. "SRVPS-80"),
           a direct GET /issue/{key} lookup — JQL's summary~ text search
           doesn't index issue keys at all, so a PO who already knows the
           key couldn't otherwise type it to jump straight to that epic.
           Best-effort: a lookup failure (typo, wrong issue type, 404) just
           means this contributes nothing, not an error for the whole call.
        2. A summary prefix search (`summary ~ "<query>*"`), most-recently-
           updated first, capped at EPIC_SEARCH_MAX_RESULTS.
        """
        query = query.strip()
        if len(query) < EPIC_SEARCH_MIN_QUERY_LENGTH:
            return []

        results: dict[str, dict] = {}

        if _ISSUE_KEY_RE.match(query):
            try:
                response = self.session.get(
                    f"{self.base_url}/rest/api/2/issue/{query.upper()}",
                    params={"fields": "summary,issuetype"},
                    timeout=15,
                )
                if response.ok:
                    data = response.json()
                    if data.get("fields", {}).get("issuetype", {}).get("name") == "Epic":
                        results[data["key"]] = {
                            "key": data["key"],
                            "name": data["fields"]["summary"],
                        }
            except requests.RequestException:
                logger.warning("Exact-key epic lookup failed for %r, continuing with text search", query)

        escaped = query.replace("\\", "\\\\").replace('"', '\\"')
        jql = f'issuetype=Epic AND summary ~ "{escaped}*" ORDER BY updated DESC'
        response = self.session.get(
            f"{self.base_url}/rest/api/2/search",
            params={
                "jql": jql,
                "fields": "summary,key",
                "maxResults": EPIC_SEARCH_MAX_RESULTS,
                "startAt": 0,
            },
            timeout=30,
        )
        response.raise_for_status()
        for issue in response.json().get("issues", []):
            results.setdefault(issue["key"], {"key": issue["key"], "name": issue["fields"]["summary"]})

        return list(results.values())[:EPIC_SEARCH_MAX_RESULTS]

    def get_accounts(self, project_id: str = field_map.PROJECT_ID) -> list[dict]:
        """Return [{"id": ..., "key": ..., "name": ...}] for Tempo accounts
        linked to this project — the PO's choices for customfield_10002.

        Backed by Tempo's own account picker (the same endpoint the real
        JIRA create-issue screen's Account dropdown calls), not the plain
        JIRA REST API — Tempo Accounts fields don't expose allowedValues
        through createmeta/editmeta (see field_map.ACCOUNT_FIELD), so this
        is the only way to list valid choices. "linked" accounts are the
        ones explicitly authorized for this project; "global" accounts are
        available everywhere and are included too since they're equally
        valid choices, just not project-specific.
        """
        url = f"{self.base_url}/rest/tempo-accounts/1/account/project/{project_id}/picker"
        response = self.session.get(url, timeout=30)
        response.raise_for_status()
        data = response.json()

        accounts = data.get("linked", []) + data.get("global", [])
        return [
            {"id": account["id"], "key": account["key"], "name": account["name"]}
            for account in accounts
        ]

    def get_publish_field_availability(self, project_key: str) -> dict:
        """Confirm which of the Publish step's known fields actually exist
        for this project's Story issue type — called when the PO changes
        the Project dropdown, to decide which fields to show vs. hide.

        Re-checks live via createmeta every time rather than assuming the
        TRKDJP field set applies everywhere: confirmed field IDs/schema
        are shared where a field exists (TRKDJP/TNOQRL/TRKDN identical),
        but existence isn't (SRVSLM has no Story issue type at all; no
        service-desk project checked does either).

        Two failure modes return {"usable": False, "error": "..."}
        instead of a "fields" key:
        - createmeta 400s outright — this identity can't create issues in
          this project at all (a project can be visible via GET /project
          without being usable here; confirmed for TRKDC/SRVCBC/TNOQPAY/
          PNREV).
        - createmeta succeeds but lists no "Story" issue type (confirmed
          for SRVSLM and every service-desk project checked).

        On success, returns {"usable": True, "error": None,
        "story_issuetype_id": ..., "fields": {name: bool}} for every name
        in _KNOWN_STORY_FIELD_IDS, plus "functional_area_options" (the
        same {"id", "value"} pairs createmeta's own allowedValues carries)
        when functional_area is present — fetched fresh per project call
        rather than hardcoded, even though the 290 options have been
        identical everywhere confirmed so far, since that isn't guaranteed
        to hold for every project.
        """
        issuetypes_response = self.session.get(
            f"{self.base_url}/rest/api/2/issue/createmeta/{project_key}/issuetypes", timeout=15
        )
        if not issuetypes_response.ok:
            return {
                "usable": False,
                "error": "No create-issue access to this project for the current JIRA credentials.",
            }

        story_type = next(
            (it for it in issuetypes_response.json().get("values", []) if it.get("name") == "Story"),
            None,
        )
        if story_type is None:
            return {"usable": False, "error": 'This project has no "Story" issue type.'}

        fields_response = self.session.get(
            f"{self.base_url}/rest/api/2/issue/createmeta/{project_key}/issuetypes/{story_type['id']}",
            timeout=30,
        )
        if not fields_response.ok:
            return {"usable": False, "error": "Could not load this project's Story fields."}

        fields_by_id = {f["fieldId"]: f for f in fields_response.json().get("values", [])}
        availability = {name: fid in fields_by_id for name, fid in _KNOWN_STORY_FIELD_IDS.items()}

        result: dict = {
            "usable": True,
            "error": None,
            "story_issuetype_id": story_type["id"],
            "fields": availability,
        }
        if availability["functional_area"]:
            functional_area_field = fields_by_id[field_map.FIELD_FUNCTIONAL_AREA]
            result["functional_area_options"] = [
                {"id": option["id"], "value": option["value"]}
                for option in functional_area_field.get("allowedValues", [])
            ]
        return result

    def search_users(self, field_id: str, query: str) -> list[dict]:
        """Type-ahead search for users, for one of the Roles tab's
        user-picker fields (Product Manager/Owner, Delivery/Service
        Manager, Software/Quality Engineer, Owner — see
        field_map.FIELD_PRODUCT_MANAGER etc).

        Backed by the field-specific autoCompleteUrl createmeta hands back
        for each userpicker field (/rest/api/1.0/users/picker?fieldName=
        <field_id>&query=...) — note the v1.0 API, distinct from the v2
        endpoints everywhere else in this client. field_id doesn't appear
        to change which users come back (it's the same user directory
        either way), but it's passed through anyway to match exactly what
        JIRA's own UI calls per field rather than assuming that.

        Returns [] for a query shorter than PICKER_MIN_QUERY_LENGTH.
        """
        query = query.strip()
        if len(query) < PICKER_MIN_QUERY_LENGTH:
            return []

        response = self.session.get(
            f"{self.base_url}/rest/api/1.0/users/picker",
            params={"fieldName": field_id, "query": query},
            timeout=15,
        )
        response.raise_for_status()
        return [
            {"name": user["name"], "displayName": user["displayName"]}
            for user in response.json().get("users", [])
        ]

    def search_groups(self, query: str) -> list[dict]:
        """Type-ahead search for JIRA groups — backs the Roles tab's
        Assigned Group field (field_map.FIELD_ASSIGNED_GROUP), the one
        role field that's a group-picker rather than a user-picker.

        Returns [] for a query shorter than PICKER_MIN_QUERY_LENGTH.
        """
        query = query.strip()
        if len(query) < PICKER_MIN_QUERY_LENGTH:
            return []

        response = self.session.get(
            f"{self.base_url}/rest/api/2/groups/picker",
            params={"query": query},
            timeout=15,
        )
        response.raise_for_status()
        return [{"name": group["name"]} for group in response.json().get("groups", [])]

    def create_issue(self, payload: dict) -> dict:
        """POST a create-issue payload (see field_map.build_story_payload).

        Returns the response JSON — on success, {"id": ..., "key": ...,
        "self": ...}. Raises requests.HTTPError on a non-2xx response,
        same as get_epics — but unlike get_epics (plain raise_for_status),
        the error message here includes the response body, since JIRA's
        4xx bodies carry the actual rejection reason (errorMessages/
        errors) that raise_for_status()'s own message discards. Still a
        requests.HTTPError/RequestException, so it flows through
        api/routes.py's existing `except requests.RequestException`
        unchanged, body and all, into the 502's `detail`.
        """
        url = f"{self.base_url}/rest/api/2/issue"
        response = self.session.post(url, json=payload, timeout=30)
        if not response.ok:
            raise requests.HTTPError(
                f"{response.status_code} {response.reason} for url {response.url}: {response.text}",
                response=response,
            )
        return response.json()

    def add_attachment(self, issue_key: str, filepath: str) -> Any:
        """Upload a local file as an attachment on an existing issue.

        Multipart/form-data upload. X-Atlassian-Token: no-check is
        required here specifically — JIRA's XSRF protection otherwise
        rejects attachment POSTs outright, unlike its other write
        endpoints (create-issue, add-comment) which don't need it.

        Returns the parsed response JSON. Typed as Any, not dict: unlike
        create_issue/add_comment, JIRA's attachments endpoint actually
        returns a JSON *array* of attachment-metadata objects (one per
        file in the request), not a single object — this call only ever
        sends one file, so callers just care that it didn't raise.
        """
        url = f"{self.base_url}/rest/api/2/issue/{issue_key}/attachments"
        path = Path(filepath)
        with path.open("rb") as fh:
            response = self.session.post(
                url,
                headers={"X-Atlassian-Token": "no-check"},
                files={"file": (path.name, fh)},
                timeout=60,
            )
        response.raise_for_status()
        return response.json()

    def add_comment(self, issue_key: str, body: str) -> dict:
        """POST a plain-text comment onto an existing issue.

        Returns the response JSON (the created comment object, including
        its own "id").
        """
        url = f"{self.base_url}/rest/api/2/issue/{issue_key}/comment"
        response = self.session.post(url, json={"body": body}, timeout=30)
        response.raise_for_status()
        return response.json()
