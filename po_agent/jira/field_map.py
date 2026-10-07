"""JIRA field/project constants, plus the create-issue payload builder.

Started as constants-only; build_story_payload was added once there was
actual JIRA write code (jira/client.py's create_issue) to feed, since it's
purely a function of these same constants and a story's fields.
"""

PROJECT_ID = "19404"
PROJECT_KEY = "TRKDJP"
ISSUE_TYPE_ID_STORY = "10001"
# PROJECT_ID/PROJECT_KEY are now just the Publish step's default/fallback
# project selection (TRKDJP, the original hardcoded target before the
# project picker), not a fixed target — build_story_payload takes
# project_id as a real per-story argument. ISSUE_TYPE_ID_STORY ("Story")
# IS still effectively fixed instance-wide: confirmed live across TRKDJP/
# TNOQRL/TRKDN/SRVSLM/several service-desk projects that issue type ids
# are global, not per-project — though not every project HAS a Story
# issue type at all (SRVSLM and every service-desk project checked don't;
# see JiraClient.get_projects/get_publish_field_availability for how that
# gets handled instead of assumed).

EPIC_PROJECT_KEY = "SRVPS"
# NOTE: epics for Dubai Justice Platform live in SRVPS ("Service - Professional
# Services"), a shared portfolio project, not in TRKDJP itself — TRKDJP has no
# Epic issue type in its scheme. SRVPS houses epics for multiple engagements
# (Dubai Justice Platform, Dubai Courts - Managed Services, Zajel, ...), but
# JiraClient.get_epics() deliberately returns all of them unfiltered — see its
# own docstring for why a summary-text or account-based filter was rejected.

ACCOUNT_FIELD = "customfield_10002"
# This is a Tempo Accounts plugin field (com.tempoplugin.tempo-accounts:
# accounts.customfield), not a plain JIRA field — neither createmeta nor
# editmeta expose allowedValues or a write schema for it, and Tempo has no
# separate REST endpoint for setting an issue's account (its own /link API
# is for linking accounts to *projects*, not individual issues). Confirmed
# live that it wants the numeric Tempo account id as a string (e.g.
# "279"), not the display name or the account key — see
# JiraClient.get_accounts (backed by the project's own Tempo account
# picker), which is now the PO's source for this value instead of a
# hardcoded constant here.

FIELD_ACCEPTANCE_CRITERIA = "customfield_11200"
FIELD_EPIC_LINK = "customfield_10009"
FIELD_STORY_TYPE = "customfield_13636"
FIELD_STORY_POINTS = "customfield_10005"
FIELD_BDD_CANDIDATE = "customfield_20007"
FIELD_SPRINT = "customfield_10007"

FIELD_FUNCTIONAL_AREA = "customfield_10300"
# A plain JIRA multiselect custom field (com.atlassian.jira.plugin.system.
# customfieldtypes:multiselect) — NOT a Tempo field, so createmeta's
# allowedValues works normally: confirmed 290 options live, identical
# {id, value} pairs everywhere the field exists (TRKDJP/TNOQRL/TRKDN).
# Confirmed write shape via an existing populated issue (TRKDJP-1994):
# reads back as [{"id": "43473", "value": "Dubai Justice Platform", ...}],
# so writes as an array of {"id": ...} refs, same "id over value" reasoning
# as ACCOUNT_FIELD (ids don't change if an option gets renamed).

# The "Roles" tab JIRA's own Create Issue screen shows alongside the fields
# above — all 8 confirmed via createmeta/TRKDJP/issuetypes/10001. Seven are
# native "user" (userpicker) fields; FIELD_ASSIGNED_GROUP is the one
# "group" (grouppicker) field among them. All eight write as {"name": ...}
# (a username for the user fields, a group name for Assigned Group) — this
# instance is Jira Server/DC, which keys users/groups by "name", not
# Cloud's "accountId"; confirmed by reading each field's value back off
# real TRKDJP issues that already have it set. Only FIELD_PRODUCT_OWNER is
# mandatory (confirmed by a live create-issue rejection); the rest are
# optional, matching JIRA's own form (no asterisks on those there either).
FIELD_PRODUCT_MANAGER = "customfield_27001"
FIELD_PRODUCT_OWNER = "customfield_27000"
FIELD_DELIVERY_MANAGER = "customfield_14201"
FIELD_SERVICE_MANAGER = "customfield_12503"
FIELD_SOFTWARE_ENGINEER = "customfield_14302"
FIELD_QUALITY_ENGINEER = "customfield_27202"
FIELD_ASSIGNED_GROUP = "customfield_10600"
FIELD_OWNER = "customfield_20112"


def build_story_payload(
    summary: str,
    description: str,
    acceptance_criteria: list[str],
    project_id: str,
    epic_key: str,
    account_id: str,
    product_owner: str,
    story_type: str = "Business",
    priority: str | None = None,
    story_points: float | None = None,
    sprint: str | None = None,
    functional_area: list[str] | None = None,
    product_manager: str | None = None,
    delivery_manager: str | None = None,
    service_manager: str | None = None,
    software_engineer: str | None = None,
    quality_engineer: str | None = None,
    assigned_group: str | None = None,
    owner: str | None = None,
) -> dict:
    """Build the POST /rest/api/2/issue body (the "fields" object) for one story.

    Always sets project (project_id — the PO's pick from the Publish
    step's Project dropdown, no longer hardcoded to TRKDJP)/issuetype/
    summary/description, the Account field (account_id — the PO's pick
    from JiraClient.get_accounts for that same project, same
    PO-selects-from-real-JIRA-data pattern as epic_key), story type,
    acceptance criteria (newline-joined text, per
    FIELD_ACCEPTANCE_CRITERIA's own comment on how po_agent stores
    multi-line house-style ACs into a single field), and product_owner
    (FIELD_PRODUCT_OWNER — the one Roles-tab field JIRA actually requires).

    priority/story_points/sprint, functional_area, and the seven other
    Roles-tab fields are all optional and left out of "fields" entirely
    when not given, rather than sent as explicit null — like ACCOUNT_FIELD
    above, FIELD_STORY_TYPE ({"value": ...}) and FIELD_SPRINT (bare
    string) are our best guess from the field names alone, not confirmed
    against the real instance yet; flagged for the first live create-issue
    test. FIELD_FUNCTIONAL_AREA and the Roles-tab fields, by contrast, ARE
    confirmed — see their own block comments above.

    Not every project has every one of these fields (confirmed live —
    e.g. TNOQRL has no assignee/fixVersions, SRVSLM/service-desk projects
    have none of the customfield_XXXXX ones at all); callers are expected
    to have already checked field availability via
    JiraClient.get_publish_field_availability and only pass values for
    fields that project's Story screen actually has, same as they already
    only pass optional args at all when the PO filled them in.
    """
    fields: dict = {
        "project": {"id": project_id},
        "issuetype": {"id": ISSUE_TYPE_ID_STORY},
        "summary": summary,
        "description": description,
        ACCOUNT_FIELD: account_id,
        FIELD_EPIC_LINK: epic_key,
        FIELD_STORY_TYPE: {"value": story_type},
        FIELD_ACCEPTANCE_CRITERIA: "\n".join(acceptance_criteria),
        FIELD_PRODUCT_OWNER: {"name": product_owner},
    }

    if priority is not None:
        fields["priority"] = {"name": priority}
    if story_points is not None:
        fields[FIELD_STORY_POINTS] = story_points
    if sprint is not None:
        fields[FIELD_SPRINT] = sprint
    if functional_area:
        fields[FIELD_FUNCTIONAL_AREA] = [{"id": option_id} for option_id in functional_area]
    if product_manager is not None:
        fields[FIELD_PRODUCT_MANAGER] = {"name": product_manager}
    if delivery_manager is not None:
        fields[FIELD_DELIVERY_MANAGER] = {"name": delivery_manager}
    if service_manager is not None:
        fields[FIELD_SERVICE_MANAGER] = {"name": service_manager}
    if software_engineer is not None:
        fields[FIELD_SOFTWARE_ENGINEER] = {"name": software_engineer}
    if quality_engineer is not None:
        fields[FIELD_QUALITY_ENGINEER] = {"name": quality_engineer}
    if assigned_group is not None:
        fields[FIELD_ASSIGNED_GROUP] = {"name": assigned_group}
    if owner is not None:
        fields[FIELD_OWNER] = {"name": owner}

    return {"fields": fields}
