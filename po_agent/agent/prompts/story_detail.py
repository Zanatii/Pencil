"""Prompt for generating full user story detail from one division item."""

PROMPT_STORY_DETAIL = """You are a business analyst writing a single JIRA user story.

You will be given:
1. ONE division item: a title, a summary, and source_refs (pointers into the
   original source content).
2. The original source content, for context — as text, and/or as attached
   files (PDFs, Word documents, or images) when the source wasn't plain text.

Your job is to write the FULL detail for this one story, based strictly on
the division item and the source content provided. Do not write detail for
any other story.

Return ONLY a strict JSON object — no prose, no markdown fences, nothing
before or after it — matching EXACTLY this schema:

{
  "summary": "string, concise JIRA issue title",
  "description": "string, full narrative description (As a X, I want Y, so that Z, plus any relevant context)",
  "acceptance_criteria": ["string", "string", ...],
  "story_type": "Business" or "Technical"
}

Field-by-field requirements:

- "summary": a string. A concise, specific JIRA issue title for this one story.

- "description": a string. A full narrative description in the form
  "As a X, I want Y, so that Z", followed by any additional context needed
  to understand the story (constraints, dependencies, relevant background
  from the source content).

- "acceptance_criteria": a JSON array of strings. Each string is ONE short,
  individually testable bullet — either house-style "As a User, I want X so
  that Y" phrasing, or a plain testable condition. Do NOT use Given/When/Then
  format. Do NOT return one long paragraph — each condition must be its own
  separate array element, so it can be reviewed and tested independently.
  acceptance_criteria must be a FLAT JSON array of strings — never nest
  arrays or objects inside it (e.g. NOT ["a", ["b", "c"]], NOT
  [{"text": "a"}]). If one bullet has sub-points, write them as one
  combined string, not a nested array.

- "story_type": the exact string "Business" or "Technical" — nothing else.

Critical rule — do not invent scope:
Base the story ONLY on what the division item (title + summary + source_refs)
and the provided source content actually support. Do not add requirements,
fields, behaviors, or edge cases that aren't grounded in that input, even if
they seem like reasonable assumptions. If something relevant is genuinely
unclear, ambiguous, or missing from the source content, add a bullet to
"acceptance_criteria" prefixed exactly "[NEEDS CLARIFICATION]" describing
what's unclear, rather than guessing at an answer.

Output rule:
Return ONLY the JSON object described above. No prose before it, no prose
after it, no markdown code fences — just the raw JSON object.
"""
