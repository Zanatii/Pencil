import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useParams } from 'react-router-dom'
import axios from 'axios'
import { Layers, Lock, Terminal, UploadCloud } from 'lucide-react'
import { apiClient } from '../api/client'
import { SignalBadge } from '../components/SignalBadge'
import { PipelineStepper } from '../components/PipelineStepper'
import { FileTypeBadge } from '../components/FileTypeBadge'
import { PIPELINE_STAGES } from '../lib/pipelineStages'

// /projects, /projects/{key}/publish-fields, and /accounts all reflect
// live JIRA/Tempo state rather than anything static — the backend already
// sends Cache-Control: no-store on these responses (see routes.py), but
// that's only enforceable going forward; this request-side header is the
// belt-and-suspenders half, telling the browser not to serve any cached
// entry for these specific calls even if one exists from before that
// backend change shipped.
const NO_CACHE_REQUEST_HEADERS = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }

interface StoryDivisionItem {
  id: string
  title: string
  summary: string
  source_refs: string[]
  extra_attachments: string[]
}

interface UserStory {
  id: string
  source_division_item_id: string | null
  summary: string
  description: string
  acceptance_criteria: string[]
  epic_key: string | null
  story_type: 'Business' | 'Technical'
  story_points: number | null
  notes: string | null
  jira_key: string | null
}

interface RunFile {
  filename: string
  url: string
  type: string
}

interface RunEpic {
  key: string
  name: string
}

interface RunAccount {
  id: number
  key: string
  name: string
}

interface RunProject {
  id: string
  key: string
  name: string
}

interface PublishFieldAvailability {
  usable: boolean
  error: string | null
  fields: Record<string, boolean>
  functional_area_options?: { id: string; value: string }[]
}

interface Run {
  run_id: string
  status: string
  source_documents: string[]
  extracted_requirements: string | null
  epics_available: RunEpic[]
  story_division: StoryDivisionItem[]
  user_stories: UserStory[]
  contradictions_flagged: string[]
  error_message: string | null
  custom_division_prompt: string | null
  custom_story_prompt: string | null
  created_at: string
  updated_at: string
}

// Extra-attachment pickers (the slide-over panel's "+ Attach files" and the
// table row's paperclip button) accept .xlsx/.xls in addition to what
// HomePage's main-upload dropzone takes (see ui/src/pages/HomePage.tsx
// ACCEPTED_EXTENSIONS) — po_agent/ingest/extractors.py's
// ATTACHMENT_EXTENSIONS now includes both, so a spreadsheet uploaded here
// is correctly forwarded to Claude as a native attachment on regenerate,
// same as PDF/DOCX/images.
const ATTACHMENT_ACCEPTED_EXTENSIONS = '.pdf,.docx,.xlsx,.xls,.png,.jpg,.jpeg,.webp,.txt'

// The real JIRA instance's Priority field options for this project,
// captured earlier — same fixed list ReviewStoryPanel's dropdown offers.
const JIRA_PRIORITY_OPTIONS = ['Critical', 'High', 'Medium', 'Low'] as const

// The three sub-views DIVISION_APPROVED covers, in order — none of these
// are run.status values (there's no backend transition between them yet),
// purely frontend state lifted to RunPage. See getStepIndex below for how
// this maps onto the rail/breadcrumb.
type ApprovedPhase = 'write' | 'review' | 'publish'

// What JIRA needs at publish time for one story, entered in the Review
// step but not persisted anywhere until the PO actually clicks "Publish
// Selected" on the Publish step — /publish is the only endpoint that
// accepts these, so until then they only ever live in RunPage's
// publishFieldsByStoryId map. storyPoints is kept as the raw input string
// (not a number) so an in-progress edit like "3." or an empty field
// doesn't get mangled by round-tripping through Number() on every
// keystroke; it's parsed once, at actual publish time.
interface PublishFields {
  projectId: string
  epicKey: string
  accountId: string
  priority: string
  storyPoints: string
  sprint: string
  comment: string
  // Multi-select — option ids (customfield_10300), not display values;
  // see FUNCTIONAL_AREA_AVAILABILITY_KEY / functionalAreaOptions below.
  functionalArea: string[]
  // Roles tab — see ROLE_FIELDS below for the customfield mapping/order.
  // All hold a bare username (or, for roleAssignedGroup, a group name),
  // same "just the identifier string" shape as epicKey/accountId.
  roleProductManager: string
  roleProductOwner: string
  roleDeliveryManager: string
  roleServiceManager: string
  roleSoftwareEngineer: string
  roleQualityEngineer: string
  roleAssignedGroup: string
  roleOwner: string
}

// TRKDJP — the original hardcoded target before the Project picker
// existed, now just the default selection (see field_map.PROJECT_ID,
// which this mirrors).
const DEFAULT_PROJECT_ID = '19404'

const EMPTY_PUBLISH_FIELDS: PublishFields = {
  projectId: DEFAULT_PROJECT_ID,
  epicKey: '',
  accountId: '',
  priority: '',
  storyPoints: '',
  sprint: '',
  comment: '',
  functionalArea: [],
  roleProductManager: '',
  roleProductOwner: '',
  roleDeliveryManager: '',
  roleServiceManager: '',
  roleSoftwareEngineer: '',
  roleQualityEngineer: '',
  roleAssignedGroup: '',
  roleOwner: '',
}

// The Roles tab's 8 fields, in JIRA's own Create Issue "Roles" tab order.
// Confirmed via createmeta (TRKDJP/Story, then cross-checked against
// TNOQRL/TRKDN) — see field_map.py for the matching customfield_XXXXX
// constants on the backend. Assigned Group is the one "group" field among
// seven "user" fields (JIRA calls a different endpoint for it — see
// searchUsers/searchGroups below); required is only ever true for Product
// Owner, matching JIRA's own form (no asterisks on the other 7 there
// either) — hardcoded here rather than trusting createmeta's own
// "required" flag, which is confirmed unreliable (reports false for
// Product Owner despite a live create-issue rejecting a story without
// it). availabilityKey matches the same name
// JiraClient._KNOWN_STORY_FIELD_IDS uses, for looking a field's per-
// project presence up in a fetched PublishFieldAvailability.
const ROLE_FIELDS: {
  key: keyof PublishFields
  label: string
  fieldId: string
  kind: 'user' | 'group'
  required?: boolean
  availabilityKey: string
}[] = [
  {
    key: 'roleProductManager',
    label: 'Product Manager',
    fieldId: 'customfield_27001',
    kind: 'user',
    availabilityKey: 'product_manager',
  },
  {
    key: 'roleProductOwner',
    label: 'Product Owner',
    fieldId: 'customfield_27000',
    kind: 'user',
    required: true,
    availabilityKey: 'product_owner',
  },
  {
    key: 'roleDeliveryManager',
    label: 'Delivery Manager',
    fieldId: 'customfield_14201',
    kind: 'user',
    availabilityKey: 'delivery_manager',
  },
  {
    key: 'roleServiceManager',
    label: 'Service Manager',
    fieldId: 'customfield_12503',
    kind: 'user',
    availabilityKey: 'service_manager',
  },
  {
    key: 'roleSoftwareEngineer',
    label: 'Software Engineer',
    fieldId: 'customfield_14302',
    kind: 'user',
    availabilityKey: 'software_engineer',
  },
  {
    key: 'roleQualityEngineer',
    label: 'Quality Engineer',
    fieldId: 'customfield_27202',
    kind: 'user',
    availabilityKey: 'quality_engineer',
  },
  {
    key: 'roleAssignedGroup',
    label: 'Assigned Group',
    fieldId: 'customfield_10600',
    kind: 'group',
    availabilityKey: 'assigned_group',
  },
  { key: 'roleOwner', label: 'Owner', fieldId: 'customfield_20112', kind: 'user', availabilityKey: 'owner' },
]

// The 4 empirically-confirmed-required fields (Account, Epic Link,
// Functional Area, Product Owner — Account/Epic Link/Product Owner each
// confirmed by a live create-issue rejection; Functional Area by the
// same on a later attempt) — hardcoded rather than trusting createmeta's
// own "required" flag, which is proven unreliable (reports false for all
// four despite JIRA enforcing them server-side). String-valued fields go
// here; functionalArea is handled alongside these in validation since
// it's array-valued ("required" there means "at least one option", not
// "non-empty string").
const REQUIRED_STRING_FIELDS_TAB_KEYS = ['epicKey', 'accountId'] as const

// The only account currently in use — preselected in the Account dropdown
// (see ReviewView's `accounts` fetch) when a story has no publish fields
// committed yet, same idea as epicKey defaulting from story.epic_key. The
// PO can still change it; this just saves a click while it's the only
// real choice.
const DEFAULT_ACCOUNT_NAME = 'Dubai Justice Platform'

// Extra-attachment paths are absolute filesystem paths from the backend
// (Windows or POSIX, whichever the server runs on) — just display the
// basename, same idea as FileTypeBadge's own extension parsing.
function getFileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

const STEP_INDEX_BY_STATUS: Record<string, number> = {
  EXTRACTING: 0,
  PENDING_ANALYSIS_REVIEW: 0,
  PENDING_DIVISION_REVIEW: 1,
  // DIVISION_APPROVED deliberately isn't listed here — see getStepIndex
  // below. It covers three different visible steps (Write Stories, Review,
  // Publish), toggled by frontend-local state, not a run.status change.
  GENERATING_STORIES: 2,
  PENDING_STORY_REVIEW: 3,
  WRITING_JIRA: 4,
  DONE: 4,
}

const APPROVED_PHASE_STEP_INDEX: Record<ApprovedPhase, number> = {
  write: 2,
  review: 3,
  publish: 4,
}

// DIVISION_APPROVED is the one status that covers three different rail
// steps/breadcrumbs: ApprovedDivisionList (Write Stories), ReviewView, and
// PublishView, switched between by frontend-local approvedPhase — there's
// no backend transition out of DIVISION_APPROVED between them. Every other
// status maps 1:1 via STEP_INDEX_BY_STATUS; this one needs the caller's
// local phase to disambiguate, hence the second param.
//
// GENERATING_STORIES/PENDING_STORY_REVIEW/WRITING_JIRA are currently dead
// states — no endpoint sets them, so RunContent never actually renders
// for them (it falls through to the raw-state debug view) — mapped here
// only as forward-compatible placeholders matching PIPELINE_STAGES'
// intended shape, not because anything exercises them today.
function getStepIndex(status: string, approvedPhase: ApprovedPhase = 'write'): number {
  if (status === 'DIVISION_APPROVED') {
    return APPROVED_PHASE_STEP_INDEX[approvedPhase]
  }
  return STEP_INDEX_BY_STATUS[status] ?? 0
}

// How far into the rail the PO can actually click, given what the run has
// produced so far — e.g. nothing past Upload is reachable before the
// first division run exists, and Write/Review/Publish only open up once
// DIVISION_APPROVED (at which point all three are mutually reachable, no
// stricter ordering within that trio — matches getStepIndex's own
// APPROVED_PHASE_STEP_INDEX treating them as siblings, not a strict
// sequence). Distinct from getStepIndex: that one says "where the run
// naturally is right now"; this one says "what am I allowed to click".
function getMaxReachableStepIndex(status: string): number {
  if (status === 'DIVISION_APPROVED') return 4
  return STEP_INDEX_BY_STATUS[status] ?? 0
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail
    if (typeof detail === 'string') return detail
    if (err.response?.status) return `${fallback} (HTTP ${err.response.status})`
  }
  return fallback
}

function EditIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M14.5 5.5 18.5 9.5M4 20l.9-4.2a1 1 0 0 1 .27-.5L14.9 5.6a1 1 0 0 1 1.4 0l2.1 2.1a1 1 0 0 1 0 1.4L8.7 18.83a1 1 0 0 1-.5.27L4 20Z"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className}>
      <path
        d="M15.5 4.5v4h-4M4.5 15.5v-4h4M4.85 8.5A5.5 5.5 0 0 1 15 6.2M15.15 11.5A5.5 5.5 0 0 1 5 13.8"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className}>
      <path
        d="M4.5 6h11M8 6V4.75A1.25 1.25 0 0 1 9.25 3.5h1.5A1.25 1.25 0 0 1 12 4.75V6M6 6l.6 9a1.5 1.5 0 0 0 1.5 1.4h3.8a1.5 1.5 0 0 0 1.5-1.4L14 6"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.5 8.5v5M11.5 8.5v5" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  )
}

function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className}>
      <path
        d="M5 7.5 10 12.5 15 7.5"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Thin-stroke, hand-drawn checkmark — deliberately not the bold default
// glyph a plain checkbox would render.
function ThinCheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className}>
      <path
        d="M4.5 10.5L8 14L15.5 6"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

interface CheckboxProps {
  checked: boolean
  onChange: () => void
  label: string
}

// A circular "select" affordance, not a form checkbox wearing a costume.
// Native <input type="checkbox"> stays visually hidden (sr-only) but real
// — focusable/keyboard-operable — with a <label> wrapping it plus the
// styled <span>, so native label-click delegation toggles it regardless of
// where visually. The checkmark's scale/opacity is driven straight from
// React `checked`, not a peer-* selector, since the icon is a *descendant*
// of the span (the actual peer), out of reach of a sibling-only selector.
function Checkbox({ checked, onChange, label }: CheckboxProps) {
  return (
    <label className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center">
      <input type="checkbox" checked={checked} onChange={onChange} aria-label={label} className="peer sr-only" />
      <span
        className={`flex h-5 w-5 items-center justify-center rounded-full border transition-all duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo/50 ${
          checked
            ? 'border-indigo bg-indigo shadow-[0_0_0_4px_rgba(124,111,242,0.22),0_0_10px_2px_rgba(124,111,242,0.5)]'
            : 'border-white/20 bg-void/40'
        }`}
      >
        <ThinCheckIcon
          className={`h-3 w-3 text-white transition-all duration-150 ${
            checked ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
          }`}
        />
      </span>
    </label>
  )
}

interface AutoGrowTextareaProps {
  value: string
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
  onBlur?: () => void
  placeholder?: string
  className?: string
  rows?: number
  /** Focuses on mount, cursor placed at the end of the existing text. */
  autoFocus?: boolean
}

// Grows to fit content instead of showing a resize grip or an internal
// scrollbar — height is recalculated on every value change (typing,
// programmatic updates like the merge preview prefill, etc), not just on
// user input, by keying a layout effect off `value`.
function AutoGrowTextarea({
  value,
  onChange,
  onBlur,
  placeholder,
  className,
  rows = 2,
  autoFocus = false,
}: AutoGrowTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  // Placing the cursor at the exact spot clicked (rather than the end)
  // would need caret-position-from-point APIs that are inconsistent
  // across browsers for this — end-of-text is the reliable fallback the
  // click-to-edit fields below settle for.
  useEffect(() => {
    if (!autoFocus) return
    const el = textareaRef.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once, on mount only
  }, [])

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      placeholder={placeholder}
      rows={rows}
      className={`resize-none overflow-hidden ${className ?? ''}`}
    />
  )
}

interface SearchableSelectOption {
  value: string
  label: string
}

interface SearchableSelectCommonProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  disabled?: boolean
}

// Static mode: the full option list is already in hand (e.g. the Account
// dropdown's one-or-few Tempo accounts) — filtering happens client-side
// against every keystroke.
interface SearchableSelectStaticProps extends SearchableSelectCommonProps {
  mode?: 'static'
  options: SearchableSelectOption[]
  isLoading?: boolean
}

// Search mode: there's no full list to filter client-side (e.g. Epic,
// searching all ~3,192 instance issues via GET /epics/search) — each
// (debounced) query is sent to the server instead.
interface SearchableSelectSearchProps extends SearchableSelectCommonProps {
  mode: 'search'
  onSearch: (query: string) => Promise<SearchableSelectOption[]>
  minQueryLength?: number
  debounceMs?: number
}

type SearchableSelectProps = SearchableSelectStaticProps | SearchableSelectSearchProps

// A type-to-filter <select> replacement: a native <select> has no way to
// narrow a long option list by typing a substring (browsers only jump to
// the first option starting with the typed character), which stops being
// usable once a list has dozens+ of entries — originally built for the
// Epic dropdown at 46 SRVPS-only options, now also carrying its
// instance-wide search (~3,192 issues) since fetching that many upfront
// isn't practical. No combobox/autocomplete library is in use anywhere in
// this app (checked package.json — plain React + Tailwind, nothing else),
// so this is a small local component in the same vein as
// AutoGrowTextarea/Checkbox above, styled with the same void/indigo
// Tailwind tokens as the plain <select>s beside it, rather than pulling in
// a new dependency for one control.
//
// Static mode filters by substring match against `label`
// (case-insensitive) — callers that want both a key and a name searchable
// (e.g. epics) just need to include both in `label`, same as the plain
// <select> it replaced already rendered ("SRVPS-80 — Public Prosecution").
// Search mode leaves matching entirely to the server (see
// JiraClient.search_epics for the equivalent key-vs-summary logic there).
function SearchableSelect(props: SearchableSelectProps) {
  const { value, onChange, placeholder, disabled = false } = props
  const isSearchMode = props.mode === 'search'

  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()

  // Search-mode-only state. searchResults is deliberately NOT cleared at
  // the start of each new search — the previous results stay on screen
  // (with the "Searching…" row layered on top, see the render below)
  // rather than flashing empty while the debounced request is in flight.
  const [searchResults, setSearchResults] = useState<SearchableSelectOption[]>([])
  const [isSearching, setIsSearching] = useState(false)
  // The label for the currently-selected `value`, resolved lazily — search
  // mode never holds a full option list, so (unlike static mode) it can't
  // just look an externally-set value (e.g. a story's previously-picked
  // epic_key) up locally; see the resolve effect below.
  const [resolvedValueLabel, setResolvedValueLabel] = useState<string | null>(null)
  const searchRequestIdRef = useRef(0)

  const minQueryLength = props.mode === 'search' ? (props.minQueryLength ?? 2) : 0
  const isLoadingStatic = props.mode !== 'search' && (props.isLoading ?? false)

  const selectedOption = isSearchMode
    ? searchResults.find((option) => option.value === value)
    : props.mode !== 'search'
      ? props.options.find((option) => option.value === value)
      : undefined
  const selectedLabel = isSearchMode
    ? (selectedOption?.label ?? resolvedValueLabel ?? value)
    : (selectedOption?.label ?? '')

  // While closed, the input mirrors the selected value's label (blank if
  // nothing's selected). While open, `query` is the PO's own in-progress
  // search text and this effect must leave it alone — it only resyncs the
  // moment closing happens (click-away, Escape, or a selection), and
  // whenever the selection changes from outside (e.g. switching which
  // story's panel is open).
  useEffect(() => {
    if (!isOpen) setQuery(selectedLabel)
  }, [isOpen, selectedLabel])

  // The moment the dropdown opens, drop whatever text is sitting in the
  // input (the previously-selected option's full label, synced in by the
  // effect above while it was closed) rather than leaving it there to
  // double as the active filter — static mode's filteredOptions matches
  // against that text verbatim, so re-opening an already-populated Project
  // field silently filtered its full option list down to just the one
  // already-selected match (confirmed live: totalOptions 58,
  // filteredOptionsCount 1). Opening should always start by showing every
  // option (static) / waiting for real input (search), same as if nothing
  // had ever been selected — separate effect from the one above so a
  // still-open dropdown's selection change (e.g. via keyboard) doesn't
  // fight with the PO's own in-progress typing.
  useEffect(() => {
    if (isOpen) setQuery('')
  }, [isOpen])

  // Search mode: resolve a display label for `value` when it arrives from
  // outside (e.g. a story's already-set epic_key) and isn't already known
  // from a recent search result. Reuses the same onSearch(query) the
  // listbox itself calls, passing the raw key as the query — search_epics'
  // own exact-key lookup path resolves that directly. Best-effort: on
  // failure the raw value just stays shown as-is (see selectedLabel above).
  useEffect(() => {
    if (props.mode !== 'search') return
    if (!value || selectedOption) {
      setResolvedValueLabel(null)
      return
    }
    let cancelled = false
    props
      .onSearch(value)
      .then((results) => {
        if (cancelled) return
        const match = results.find((option) => option.value === value)
        if (match) setResolvedValueLabel(match.label)
      })
      .catch(() => {
        // Best-effort — the raw value is still shown as a fallback.
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-resolve when the externally-set value itself changes
  }, [props.mode, value])

  const trimmedQuery = query.trim()
  const trimmedQueryLower = trimmedQuery.toLowerCase()
  const filteredOptions =
    props.mode === 'search'
      ? searchResults
      : trimmedQueryLower === ''
        ? props.options
        : props.options.filter((option) => option.label.toLowerCase().includes(trimmedQueryLower))

  // Debounced server search — fires only in search mode, only while open,
  // and only once the query clears the minimum length (so a stray
  // keystroke or two never fires an unscoped instance-wide JQL query; the
  // hard floor for that lives server-side too, see
  // JiraClient.EPIC_SEARCH_MIN_QUERY_LENGTH). A monotonic request id
  // guards against an earlier, slower request's response clobbering a
  // later one's (fast typing can easily resolve out of order).
  useEffect(() => {
    if (props.mode !== 'search' || !isOpen) return
    if (trimmedQuery.length < minQueryLength) {
      setSearchResults([])
      setIsSearching(false)
      return
    }
    setIsSearching(true)
    const requestId = ++searchRequestIdRef.current
    const handle = setTimeout(() => {
      props
        .onSearch(trimmedQuery)
        .then((results) => {
          if (searchRequestIdRef.current !== requestId) return
          setSearchResults(results)
        })
        .catch(() => {
          if (searchRequestIdRef.current !== requestId) return
          setSearchResults([])
        })
        .finally(() => {
          if (searchRequestIdRef.current === requestId) setIsSearching(false)
        })
    }, props.debounceMs ?? 300)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only on the debounced query text (or open state) changing; onSearch/minQueryLength/debounceMs are stable per mount
  }, [trimmedQuery, isOpen])

  // Reset highlight on option-set changes (not on every re-render — see
  // filteredOptionsKey below), and whenever the list opens/closes.
  const filteredOptionsKey = filteredOptions.map((option) => option.value).join('|')
  useEffect(() => {
    setHighlightedIndex(0)
  }, [filteredOptionsKey, isOpen])

  useEffect(() => {
    if (!isOpen) return
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  function selectOption(option: SearchableSelectOption) {
    onChange(option.value)
    setQuery(option.label)
    setIsOpen(false)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!isOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
        event.preventDefault()
        setIsOpen(true)
      }
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((index) => Math.min(index + 1, filteredOptions.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const option = filteredOptions[highlightedIndex]
      if (option) selectOption(option)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setIsOpen(false)
      inputRef.current?.blur()
    }
  }

  const showListbox = isOpen && !isLoadingStatic
  const showSearchingRow = isSearchMode && isSearching

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        autoComplete="off"
        value={isLoadingStatic ? '' : query}
        onChange={(event) => {
          setQuery(event.target.value)
          setIsOpen(true)
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        disabled={disabled || isLoadingStatic}
        placeholder={isLoadingStatic ? 'Loading…' : placeholder}
        className="block w-full rounded-md border border-white/10 bg-void/40 py-2 pl-2 pr-8 text-sm text-white/90 outline-none focus:border-indigo focus:ring-1 focus:ring-indigo disabled:cursor-not-allowed disabled:opacity-50"
      />
      <ChevronIcon className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
      {showListbox && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto overscroll-contain rounded-md border border-white/10 bg-abyss/95 py-1 shadow-lg backdrop-blur-md"
        >
          {isSearchMode && trimmedQuery.length < minQueryLength ? (
            <li className="px-3 py-2 text-sm text-white/40">
              Type at least {minQueryLength} characters to search…
            </li>
          ) : (
            <>
              {showSearchingRow && (
                <li className="flex items-center gap-1.5 px-3 py-2 text-xs uppercase tracking-wide text-white/30">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo" />
                  Searching…
                </li>
              )}
              {filteredOptions.length === 0 ? (
                !showSearchingRow && <li className="px-3 py-2 text-sm text-white/40">No matches</li>
              ) : (
                filteredOptions.map((option, index) => (
                  <li
                    key={option.value}
                    role="option"
                    aria-selected={option.value === value}
                    // onMouseDown (not onClick) fires before the input's onBlur,
                    // so preventDefault here keeps focus in the input instead of
                    // the blur closing the list first and losing the click.
                    onMouseDown={(event) => {
                      event.preventDefault()
                      selectOption(option)
                    }}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    className={`cursor-pointer px-3 py-2 text-sm ${
                      index === highlightedIndex ? 'bg-indigo/20 text-white' : 'text-white/80'
                    }`}
                  >
                    {option.label}
                  </li>
                ))
              )}
            </>
          )}
        </ul>
      )}
    </div>
  )
}

interface MultiSearchableSelectOption {
  value: string
  label: string
}

interface MultiSearchableSelectProps {
  options: MultiSearchableSelectOption[]
  values: string[]
  onChange: (values: string[]) => void
  placeholder: string
  disabled?: boolean
}

// Same type-to-filter idea as SearchableSelect's static mode, but for
// picking several options at once (Functional Area, a multiselect field —
// see field_map.FIELD_FUNCTIONAL_AREA). Kept as its own smaller component
// rather than bolting a multi/single dimension onto SearchableSelect
// (already static-vs-search) — selecting toggles membership and keeps the
// list open (multi-select pickers don't close on every pick), the closed-
// state display summarizes a count instead of showing one label, and
// there's no async mode to support (Functional Area's ~290 options are
// already fetched wholesale per project, same as Account).
function MultiSearchableSelect({
  options,
  values,
  onChange,
  placeholder,
  disabled = false,
}: MultiSearchableSelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()

  const trimmedQuery = query.trim().toLowerCase()
  const filteredOptions =
    trimmedQuery === ''
      ? options
      : options.filter((option) => option.label.toLowerCase().includes(trimmedQuery))

  useEffect(() => {
    setHighlightedIndex(0)
  }, [trimmedQuery, isOpen])

  useEffect(() => {
    if (!isOpen) return
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  function toggleOption(optionValue: string) {
    onChange(
      values.includes(optionValue) ? values.filter((v) => v !== optionValue) : [...values, optionValue],
    )
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!isOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
        event.preventDefault()
        setIsOpen(true)
      }
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((index) => Math.min(index + 1, filteredOptions.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const option = filteredOptions[highlightedIndex]
      if (option) toggleOption(option.value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setIsOpen(false)
      inputRef.current?.blur()
    }
  }

  const selectedLabels = options.filter((option) => values.includes(option.value)).map((option) => option.label)
  const summaryText =
    selectedLabels.length === 0
      ? ''
      : selectedLabels.length <= 2
        ? selectedLabels.join(', ')
        : `${selectedLabels.length} selected`

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-white/10 bg-void/40 py-2 pl-2 pr-2 text-left text-sm outline-none focus:border-indigo focus:ring-1 focus:ring-indigo disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={`truncate ${summaryText ? 'text-white/90' : 'text-white/25'}`}>
          {summaryText || placeholder}
        </span>
        <ChevronIcon className="h-4 w-4 shrink-0 text-white/40" />
      </button>
      {isOpen && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-white/10 bg-abyss/95 shadow-lg backdrop-blur-md">
          <input
            ref={inputRef}
            type="text"
            autoFocus
            role="combobox"
            aria-expanded={isOpen}
            aria-controls={listboxId}
            aria-autocomplete="list"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Filter…"
            className="w-full border-b border-white/10 bg-transparent px-3 py-2 text-sm text-white/90 outline-none placeholder:text-white/25"
          />
          <ul
            id={listboxId}
            role="listbox"
            aria-multiselectable="true"
            className="max-h-60 overflow-y-auto overscroll-contain py-1"
          >
            {filteredOptions.length === 0 ? (
              <li className="px-3 py-2 text-sm text-white/40">No matches</li>
            ) : (
              filteredOptions.map((option, index) => {
                const checked = values.includes(option.value)
                return (
                  <li
                    key={option.value}
                    role="option"
                    aria-selected={checked}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      toggleOption(option.value)
                    }}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ${
                      index === highlightedIndex ? 'bg-indigo/20 text-white' : 'text-white/80'
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        checked ? 'border-indigo bg-indigo' : 'border-white/20'
                      }`}
                    >
                      {checked && <ThinCheckIcon className="h-2.5 w-2.5 text-white" />}
                    </span>
                    {option.label}
                  </li>
                )
              })
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

// Local hook: briefly flip a boolean true then back to false, cancelling
// any prior pending flip and cleaning up on unmount — the same "flash a
// confirmation, then let it fade" pattern the merge highlight uses, reused
// here for the click-to-edit fields' on-blur "Saved" cue.
function useSavedFlash(): [boolean, () => void] {
  const [justSaved, setJustSaved] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  function flash() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setJustSaved(true)
    timeoutRef.current = setTimeout(() => setJustSaved(false), 1200)
  }

  return [justSaved, flash]
}

// Same "briefly show a confirmation, then let it fade" shape as
// useSavedFlash, but carrying its own message text ("Attached"/"Removed")
// instead of a fixed boolean — used where an action confirms itself with
// different words depending on which action just completed, rather than
// always saying "Saved". ~1.5s, matching the requested fade timing (vs.
// useSavedFlash's 1.2s elsewhere) since this stands alone rather than
// beside a Save button that already implies "this took effect".
function useMessageFlash(durationMs = 1500): [string | null, (message: string) => void] {
  const [message, setMessage] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  function flash(newMessage: string) {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setMessage(newMessage)
    timeoutRef.current = setTimeout(() => setMessage(null), durationMs)
  }

  return [message, flash]
}

// Single run view. Local top bar (nav back + run badge + Proxi status) sits
// below the global TopBar from App.tsx, then a status line, then a left
// rail (vertical PipelineStepper) + main canvas laid out side by side.

interface DefaultPrompts {
  division_prompt: string
  story_prompt: string
}

export function RunPage() {
  const { runId } = useParams<{ runId: string }>()

  const [run, setRun] = useState<Run | null>(null)
  const [isLoadingRun, setIsLoadingRun] = useState(true)
  const [runError, setRunError] = useState<string | null>(null)

  // Fetched once on mount (not per-runId — these are the global defaults,
  // not run-specific) so the "View Prompt" popovers always have something
  // to seed their textarea with, even before the PO has ever opened one.
  // A fetch failure just leaves this null; the popovers still work off
  // the run's own custom_*_prompt if one is already set, they just can't
  // show a default to fall back to until this loads (or ever, if it
  // never does) — not worth its own error banner for a background fetch.
  const [defaultPrompts, setDefaultPrompts] = useState<DefaultPrompts | null>(null)
  useEffect(() => {
    apiClient
      .get<DefaultPrompts>('/prompts')
      .then((response) => setDefaultPrompts(response.data))
      .catch(() => {})
  }, [])

  const [isDividing, setIsDividing] = useState(false)
  const [divideError, setDivideError] = useState<string | null>(null)

  // All three live here (not local to whichever sub-view, where the first
  // of them originated) because the left-rail stepper and breadcrumb —
  // both rendered up here — need approvedPhase too: DIVISION_APPROVED
  // alone can't tell Write Stories/Review/Publish apart, since there's no
  // backend status transition between them yet, only this. The other two
  // are the Review step's own working state (which stories are checked to
  // publish, and each one's not-yet-persisted JIRA fields) — lifted here
  // rather than local to ReviewView so PublishView (a sibling, not a
  // descendant) can read them once the PO continues past Review. All
  // three reset on every run navigation so a fresh run never inherits a
  // previous run's in-progress review/publish state.
  const [approvedPhase, setApprovedPhase] = useState<ApprovedPhase>('write')
  const [includedStoryIds, setIncludedStoryIds] = useState<Set<string>>(new Set())
  const [publishFieldsByStoryId, setPublishFieldsByStoryId] = useState<Record<string, PublishFields>>({})
  // null = following the run's natural current step, same as before the
  // rail became clickable. Set to 0 or 1 by clicking Upload/Breakdown on
  // the rail to explicitly revisit one of them — the only two steps that
  // can ever be a *historical* view (Write Stories/Review/Publish stay
  // live no matter which one is clicked, so they don't need this; see
  // handleStepClick). Cleared back to null by clicking any of those three.
  const [viewingReadOnlyStep, setViewingReadOnlyStep] = useState<0 | 1 | null>(null)
  useEffect(() => {
    setApprovedPhase('write')
    setIncludedStoryIds(new Set())
    setPublishFieldsByStoryId({})
    setViewingReadOnlyStep(null)
  }, [runId])

  // naturalStepIndex: where the run really is (drives "completed" styling
  // on the rail, independent of what's currently on screen).
  // viewedStepIndex: what's actually being shown right now — same as
  // naturalStepIndex unless viewingReadOnlyStep overrides it.
  // isViewedEarlyStepReadOnly: true only when the PO explicitly clicked
  // back to Upload/Breakdown AND the run has since moved past that step
  // for real — landing on Upload/Breakdown because that's simply where
  // the run naturally is right now (nothing to revisit yet) stays fully
  // live, same as always.
  const naturalStepIndex = run ? getStepIndex(run.status, approvedPhase) : 0
  const viewedStepIndex = viewingReadOnlyStep ?? naturalStepIndex
  const maxReachableStepIndex = run ? getMaxReachableStepIndex(run.status) : 0
  const isViewedEarlyStepReadOnly =
    viewingReadOnlyStep === 0
      ? run?.status !== 'PENDING_ANALYSIS_REVIEW'
      : viewingReadOnlyStep === 1
        ? run?.status !== 'PENDING_DIVISION_REVIEW'
        : false

  function handleStepClick(index: number) {
    if (index > maxReachableStepIndex) return
    if (index === 0 || index === 1) {
      setViewingReadOnlyStep(index)
      return
    }
    // Write Stories / Review / Publish — always fully live, whichever one
    // is clicked, per the "content review is fluid" rule; only reachable
    // (per maxReachableStepIndex) once DIVISION_APPROVED.
    setViewingReadOnlyStep(null)
    setApprovedPhase(index === 2 ? 'write' : index === 3 ? 'review' : 'publish')
  }

  const fetchRun = useCallback(async () => {
    if (!runId) return
    setIsLoadingRun(true)
    setRunError(null)
    try {
      const response = await apiClient.get<Run>(`/runs/${runId}`)
      setRun(response.data)
    } catch (err) {
      setRunError(extractErrorMessage(err, 'Failed to load run.'))
    } finally {
      setIsLoadingRun(false)
    }
  }, [runId])

  useEffect(() => {
    fetchRun()
  }, [fetchRun])

  async function handleRunDivision() {
    if (!runId) return
    setIsDividing(true)
    setDivideError(null)
    try {
      await apiClient.post(`/runs/${runId}/divide`)
      await fetchRun()
    } catch (err) {
      setDivideError(extractErrorMessage(err, 'Failed to run division analysis.'))
    } finally {
      setIsDividing(false)
    }
  }

  function handleRunUpdated(updatedRun: Run) {
    setRun(updatedRun)
  }

  // Every generated story is checked by default on entry — the PO opts
  // OUT of publishing something in Review, rather than opting in from
  // scratch. Computed fresh from run.user_stories at the moment of
  // continuing (not kept live afterward): a story generated after this
  // point can't happen anyway, since Write Stories isn't reachable again
  // without a run reload.
  function handleContinueToReview() {
    if (!run) return
    setIncludedStoryIds(new Set(run.user_stories.map((story) => story.id)))
    setApprovedPhase('review')
  }

  function handleContinueToPublish() {
    setApprovedPhase('publish')
  }

  function toggleIncludedStory(storyId: string) {
    setIncludedStoryIds((ids) => {
      const next = new Set(ids)
      if (next.has(storyId)) {
        next.delete(storyId)
      } else {
        next.add(storyId)
      }
      return next
    })
  }

  // Merges a partial update into one story's field, seeding from
  // EMPTY_PUBLISH_FIELDS the first time a given story is touched — so
  // ReviewStoryPanel/ReviewView never have to null-check the map
  // themselves before reading a field back out of it.
  function updatePublishFields(storyId: string, patch: Partial<PublishFields>) {
    setPublishFieldsByStoryId((fields) => ({
      ...fields,
      [storyId]: { ...(fields[storyId] ?? EMPTY_PUBLISH_FIELDS), ...patch },
    }))
  }

  return (
    <div className="min-h-screen bg-void-gradient font-body">
      {/* RunPage used to render two more header rows of its own here
          (← New Run/RUN pill/Proxi, then a Created/N files line) stacked
          below the global TopBar. Both are gone now — New Run and Proxi
          merged into TopBar's single row (it's route-aware, see
          TopBar.tsx), the run-id pill and the Created/files line were
          dropped outright — so the rail/content flex row sits directly
          under TopBar with tightened top padding, not a leftover gap
          where those rows used to be. */}
      <div className="flex">
        <aside className="w-[260px] shrink-0 border-r border-white/15 px-6 pb-8 pt-4">
          <PipelineStepper
            activeIndex={naturalStepIndex}
            viewedIndex={viewedStepIndex}
            maxReachableIndex={maxReachableStepIndex}
            isViewedStepReadOnly={isViewedEarlyStepReadOnly}
            onStepClick={handleStepClick}
          />
        </aside>

        <main className="flex-1 px-12 pb-10 pt-4">
          {isLoadingRun && <p className="text-white/50">Loading run…</p>}
          {runError && <p className="text-red-400">{runError}</p>}

          {!isLoadingRun && !runError && run && (
            <RunContent
              run={run}
              isDividing={isDividing}
              divideError={divideError}
              onRunDivision={handleRunDivision}
              onDivisionApproved={fetchRun}
              onRunUpdated={handleRunUpdated}
              approvedPhase={approvedPhase}
              viewingReadOnlyStep={viewingReadOnlyStep}
              onContinueToReview={handleContinueToReview}
              onContinueToPublish={handleContinueToPublish}
              onBackToReview={() => setApprovedPhase('review')}
              includedStoryIds={includedStoryIds}
              onToggleIncludedStory={toggleIncludedStory}
              publishFieldsByStoryId={publishFieldsByStoryId}
              onUpdatePublishFields={updatePublishFields}
              defaultPrompts={defaultPrompts}
            />
          )}
        </main>
      </div>
    </div>
  )
}

// "PHASE 1 · UPLOAD   STEP 1 OF 5" — sits above every view's heading.
// Phase and step happen to be the same number here (each pipeline stage
// is exactly one step, no sub-steps within a phase), unlike richer
// multi-step-per-phase schemes; still rendered as two separate pieces per
// the reference pattern rather than collapsed into one, so the shape
// stays consistent if that ever changes.
function PhaseBreadcrumb({
  status,
  approvedPhase = 'write',
  forceStepIndex,
}: {
  status: string
  /** Disambiguates DIVISION_APPROVED (Write Stories/Review/Publish) — see
   *  getStepIndex. Every other status ignores this. */
  approvedPhase?: ApprovedPhase
  /** Bypasses status/approvedPhase-based derivation entirely — needed
   *  when viewing Upload/Breakdown as a read-only revisit, where
   *  run.status has already moved past PENDING_ANALYSIS_REVIEW/
   *  PENDING_DIVISION_REVIEW and the normal derivation would compute the
   *  wrong (current) phase instead of the one actually on screen. */
  forceStepIndex?: number
}) {
  const stepIndex = forceStepIndex ?? getStepIndex(status, approvedPhase)
  const phaseLabel = PIPELINE_STAGES[stepIndex] ?? ''
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="rounded-full border border-indigo/20 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-indigo shadow-[0_0_8px_rgba(124,111,242,0.15)]">
        Phase {stepIndex + 1} · {phaseLabel}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-wider text-white/40">
        Step {stepIndex + 1} of {PIPELINE_STAGES.length}
      </span>
    </div>
  )
}

// The visual cue for "you're looking at a locked historical step" — used
// wherever Upload/Breakdown render in read-only revisit mode (see
// RunContent's showUpload/showBreakdown), so it's clear at a glance why
// every control on screen is inert, not just on the rail's own small lock
// badge (see PipelineStepper).
function ReadOnlyBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1 font-mono text-xs uppercase tracking-wide text-white/50">
      <Lock className="h-3 w-3" strokeWidth={2} />
      Read-Only
    </span>
  )
}

interface PromptOverrideButtonProps {
  runId: string
  run: Run
  /** Which of the run's two override fields this button edits — also
   *  picks the matching key out of GET /prompts' response. */
  field: 'division' | 'story'
  defaultPrompts: DefaultPrompts | null
  onRunUpdated: (run: Run) => void
}

// Small icon button + anchored popover (not a full modal) for viewing/
// editing this run's custom_division_prompt or custom_story_prompt.
// Placed next to "Break Into User Stories" (field="division") and
// "Generate All" (field="story").
//
// PUT /runs/{run_id}/prompts sets BOTH fields from the request body every
// call — it's not a partial-update endpoint (see routes.py: it assigns
// state.custom_division_prompt = body.division_prompt unconditionally,
// same for story). So applying/resetting one field here always sends the
// OTHER field's current value from `run` verbatim, never omits it —
// otherwise editing the division prompt would silently null out an
// already-set custom story_prompt on the same run. This is also exactly
// why a custom prompt on one run/one field can't leak into another run or
// the other field: every write is scoped to this run_id and carries the
// other field's existing value through untouched.
function PromptOverrideButton({ runId, run, field, defaultPrompts, onRunUpdated }: PromptOverrideButtonProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [text, setText] = useState('')
  const [savingAction, setSavingAction] = useState<'apply' | 'reset' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const currentOverride = field === 'division' ? run.custom_division_prompt : run.custom_story_prompt
  const defaultPrompt = field === 'division' ? defaultPrompts?.division_prompt : defaultPrompts?.story_prompt
  const label = field === 'division' ? 'Breakdown' : 'Write Stories'
  const isOverridden = currentOverride !== null

  function openPanel() {
    setText(currentOverride ?? defaultPrompt ?? '')
    setError(null)
    setIsOpen(true)
  }

  async function submitPromptUpdate(newValue: string | null, action: 'apply' | 'reset') {
    setSavingAction(action)
    setError(null)
    try {
      const response = await apiClient.put<Run>(`/runs/${runId}/prompts`, {
        division_prompt: field === 'division' ? newValue : run.custom_division_prompt,
        story_prompt: field === 'story' ? newValue : run.custom_story_prompt,
      })
      onRunUpdated(response.data)
      setIsOpen(false)
    } catch (err) {
      setError(extractErrorMessage(err, 'Failed to save prompt.'))
    } finally {
      setSavingAction(null)
    }
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => (isOpen ? setIsOpen(false) : openPanel())}
        title={`View/edit the ${label} prompt for this run`}
        aria-label={`View/edit the ${label} prompt for this run`}
        className={`flex h-11 w-11 items-center justify-center rounded-md border transition-colors ${
          isOverridden
            ? 'border-indigo/40 bg-indigo/10 text-indigo'
            : 'border-white/15 text-white/60 hover:border-indigo/40 hover:text-indigo'
        }`}
      >
        <Terminal className="h-4 w-4" strokeWidth={2} />
      </button>

      {isOpen && (
        <>
          {/* Invisible click-outside catcher, not a darkened backdrop —
              this is a popover, not a modal; same convention (fixed
              full-viewport layer behind, stopPropagation on the panel
              itself) the slide-over panels use to close on outside click,
              just without the bg-black/60 dimming since this shouldn't
              read as blocking the whole page. */}
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div
            onClick={(event) => event.stopPropagation()}
            className="absolute right-0 top-full z-50 mt-2 w-[28rem] max-w-[90vw] rounded-xl border border-white/15 bg-abyss p-4 text-left shadow-2xl shadow-black/50"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-mono text-xs font-medium uppercase tracking-wide text-white/60">
                {label} Prompt
              </h3>
              {isOverridden && (
                <span className="rounded-full border border-indigo/30 bg-indigo/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-indigo">
                  Custom
                </span>
              )}
            </div>

            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={12}
              placeholder={defaultPrompt === undefined ? 'Loading default prompt…' : undefined}
              className="themed-scroll mt-2 w-full resize-y rounded-md border border-white/10 bg-void/40 p-2 font-mono text-xs leading-relaxed text-white/80 outline-none placeholder:text-white/30 focus:border-indigo focus:ring-1 focus:ring-indigo"
            />

            <p className="mt-2 text-xs text-white/40">
              Editing here only affects this run — the default prompt used by other runs is
              unchanged.
            </p>

            {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => submitPromptUpdate(null, 'reset')}
                disabled={!isOverridden || savingAction !== null}
                className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-white/60 transition-colors hover:border-clay/40 hover:text-clay disabled:cursor-not-allowed disabled:opacity-40"
              >
                {savingAction === 'reset' ? 'Resetting…' : 'Reset to Default'}
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  disabled={savingAction !== null}
                  className="rounded-md px-3 py-1.5 text-xs text-white/50 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => submitPromptUpdate(text, 'apply')}
                  disabled={savingAction !== null}
                  className="rounded-md bg-indigo px-3 py-1.5 text-xs font-medium text-white shadow shadow-indigo/30 transition-shadow hover:shadow-indigo/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {savingAction === 'apply' ? 'Applying…' : 'Apply for This Run'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

interface SectionHeaderCardProps {
  status: string
  heading: string
  itemCount?: number
  /** See PhaseBreadcrumb's own forceStepIndex. */
  forceStepIndex?: number
  /** Shows the small lock pill next to SignalBadge — see ReadOnlyBadge. */
  readOnlyBadge?: boolean
  /** The view's primary CTA, if it has one — rendered next to the heading
   *  instead of floating/sticky at the bottom of the page, so it's always
   *  visible without scrolling regardless of how long the content below
   *  the card runs. */
  action?: ReactNode
}

function SectionHeaderCard({
  status,
  heading,
  itemCount,
  forceStepIndex,
  readOnlyBadge,
  action,
}: SectionHeaderCardProps) {
  return (
    <div className="rounded-xl border border-white/15 bg-glass p-6 backdrop-blur-md">
      <PhaseBreadcrumb status={status} forceStepIndex={forceStepIndex} />
      <div className="flex flex-wrap items-center gap-2">
        <SignalBadge status={status} />
        {readOnlyBadge && <ReadOnlyBadge />}
        {itemCount !== undefined && (
          <span className="rounded-full border border-white/10 bg-glass px-3 py-1 font-mono text-xs text-white/50">
            {itemCount} item{itemCount === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between gap-4">
        <h1 className="font-display text-2xl font-semibold text-white">{heading}</h1>
        {action}
      </div>
    </div>
  )
}

interface CollapsibleSectionProps {
  label: string
  children: ReactNode
}

function CollapsibleSection({ label, children }: CollapsibleSectionProps) {
  const [isExpanded, setIsExpanded] = useState(true)

  return (
    <div className="rounded-xl border border-white/15 bg-glass backdrop-blur-md">
      <button
        type="button"
        onClick={() => setIsExpanded((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="font-mono text-xs font-medium uppercase tracking-wide text-white/50">{label}</span>
        <ChevronIcon
          className={`h-4 w-4 text-white/40 transition-transform ${isExpanded ? '' : '-rotate-90'}`}
        />
      </button>
      {isExpanded && <div className="border-t border-white/10 p-4">{children}</div>}
    </div>
  )
}

interface RunContentProps {
  run: Run
  isDividing: boolean
  divideError: string | null
  onRunDivision: () => void
  onDivisionApproved: () => Promise<void>
  onRunUpdated: (run: Run) => void
  /** Write Stories / Review / Publish, within DIVISION_APPROVED — see
   *  RunPage's own approvedPhase for why it lives up there. */
  approvedPhase: ApprovedPhase
  /** Set when the PO clicked back to Upload (0) or Breakdown (1) on the
   *  rail — forces that step's content on screen regardless of
   *  run.status, read-only if the run has actually moved past it. null
   *  means "show whatever the run's natural current step is", same as
   *  before the rail became clickable. See RunPage's own viewingReadOnlyStep. */
  viewingReadOnlyStep: 0 | 1 | null
  onContinueToReview: () => void
  onContinueToPublish: () => void
  onBackToReview: () => void
  includedStoryIds: Set<string>
  onToggleIncludedStory: (storyId: string) => void
  publishFieldsByStoryId: Record<string, PublishFields>
  onUpdatePublishFields: (storyId: string, patch: Partial<PublishFields>) => void
  defaultPrompts: DefaultPrompts | null
}

function RunContent({
  run,
  isDividing,
  divideError,
  onRunDivision,
  onDivisionApproved,
  onRunUpdated,
  approvedPhase,
  viewingReadOnlyStep,
  onContinueToReview,
  onContinueToPublish,
  onBackToReview,
  includedStoryIds,
  onToggleIncludedStory,
  publishFieldsByStoryId,
  defaultPrompts,
  onUpdatePublishFields,
}: RunContentProps) {
  // Which of Upload/Breakdown is actually on screen: an explicit revisit
  // click always wins; otherwise it's whichever one the run is naturally
  // sitting at right now (or neither, once past both — DIVISION_APPROVED).
  const showUpload =
    viewingReadOnlyStep === 0 || (viewingReadOnlyStep === null && run.status === 'PENDING_ANALYSIS_REVIEW')
  const showBreakdown =
    viewingReadOnlyStep === 1 || (viewingReadOnlyStep === null && run.status === 'PENDING_DIVISION_REVIEW')

  if (showUpload) {
    // Read-only only when this is a REVISIT after the run has actually
    // moved on — landing here because it's simply where the run is right
    // now stays fully live, same as always.
    const readOnly = run.status !== 'PENDING_ANALYSIS_REVIEW'
    return (
      <div className="flex max-w-7xl flex-col gap-6">
        {/* No card wrapper — matches Write Stories/Review/Publish's own
            header treatment (bottom border only, sitting directly on the
            page background) instead of the old bordered/bg
            SectionHeaderCard box. Still keeps the breadcrumb + pills row
            SectionHeaderCard used to render (Write Stories has none of
            its own, so there's no exact precedent for that piece — this
            just keeps it in the same relative spot, above the icon+
            heading row). */}
        <div className="border-b border-white/10 pb-6">
          <PhaseBreadcrumb status={run.status} forceStepIndex={0} />
          <div className="flex flex-wrap items-center gap-2">
            <SignalBadge status={run.status} />
            {readOnly && <ReadOnlyBadge />}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-indigo/40 bg-glass shadow-[0_0_16px_rgba(124,111,242,0.25)]">
                <UploadCloud className="h-5 w-5 text-indigo" strokeWidth={2} />
              </div>
              <h1 className="bg-gradient-to-r from-indigo to-teal bg-clip-text font-display text-2xl font-semibold text-transparent">
                Your Requirements
              </h1>
            </div>

            {!readOnly && (
              <div className="flex shrink-0 items-center gap-2">
                <PromptOverrideButton
                  runId={run.run_id}
                  run={run}
                  field="division"
                  defaultPrompts={defaultPrompts}
                  onRunUpdated={onRunUpdated}
                />
                <button
                  type="button"
                  onClick={onRunDivision}
                  disabled={isDividing}
                  className="shrink-0 rounded-md bg-indigo px-6 py-3 text-sm font-medium text-white shadow-lg shadow-indigo/30 transition-shadow hover:shadow-indigo/50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isDividing ? (
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
                      Breaking Into User Stories…
                    </span>
                  ) : (
                    'Break Into User Stories'
                  )}
                </button>
              </div>
            )}
          </div>
        </div>

        {!readOnly && divideError && <p className="text-red-400">{divideError}</p>}

        <SourceFilesSection runId={run.run_id} />

        <ExtractedRequirementsSection run={run} onRunUpdated={onRunUpdated} readOnly={readOnly} />
      </div>
    )
  }

  if (showBreakdown) {
    const readOnly = run.status !== 'PENDING_DIVISION_REVIEW'
    return <DivisionSection run={run} onDivisionApproved={onDivisionApproved} readOnly={readOnly} />
  }

  if (run.status === 'DIVISION_APPROVED') {
    if (approvedPhase === 'review') {
      return (
        <ReviewView
          run={run}
          onRunUpdated={onRunUpdated}
          includedStoryIds={includedStoryIds}
          onToggleIncludedStory={onToggleIncludedStory}
          publishFieldsByStoryId={publishFieldsByStoryId}
          onUpdatePublishFields={onUpdatePublishFields}
          onContinueToPublish={onContinueToPublish}
        />
      )
    }
    if (approvedPhase === 'publish') {
      return (
        <PublishView
          run={run}
          onRunUpdated={onRunUpdated}
          includedStoryIds={includedStoryIds}
          publishFieldsByStoryId={publishFieldsByStoryId}
          onBackToReview={onBackToReview}
        />
      )
    }
    return (
      <ApprovedDivisionList
        run={run}
        onRunUpdated={onRunUpdated}
        onContinueToReview={onContinueToReview}
        defaultPrompts={defaultPrompts}
      />
    )
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <SectionHeaderCard status={run.status} heading="Run State" />
      <CollapsibleSection label="Raw State">
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-white/70">
          {JSON.stringify(run, null, 2)}
        </pre>
      </CollapsibleSection>
    </div>
  )
}

interface SourceFilesSectionProps {
  runId: string
}

function SourceFilesSection({ runId }: SourceFilesSectionProps) {
  const [files, setFiles] = useState<RunFile[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)
    apiClient
      .get<RunFile[]>(`/runs/${runId}/files`)
      .then((response) => {
        if (!cancelled) setFiles(response.data)
      })
      .catch((err) => {
        if (!cancelled) setError(extractErrorMessage(err, 'Failed to load source files.'))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [runId])

  return (
    <CollapsibleSection label="Source Files">
      {isLoading && <p className="text-sm text-white/50">Loading files…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!isLoading && !error && files.length === 0 && (
        <p className="text-sm text-white/50">No files attached to this run.</p>
      )}
      {!isLoading && !error && files.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {files.map((file) => (
            <a
              key={file.filename}
              // file.url is relative (e.g. "/files/{run_id}/{filename}"),
              // pointing at the API's own StaticFiles mount — it has to be
              // resolved against the API's origin, not the frontend's, or
              // the browser would try (and fail) to fetch it from the Vite
              // dev server instead.
              href={`${apiClient.defaults.baseURL}${file.url}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-md border border-white/10 bg-void/30 px-2.5 py-1.5 text-left transition-colors hover:border-indigo/40"
            >
              <FileTypeBadge filename={file.filename} />
              <span className="min-w-0 flex-1 truncate text-sm text-white/80">
                {file.filename}
              </span>
            </a>
          ))}
        </div>
      )}
    </CollapsibleSection>
  )
}

interface ExtractedRequirementsSectionProps {
  run: Run
  onRunUpdated: (run: Run) => void
  /** Locked when Upload is being viewed as a historical revisit — see
   *  RunContent's showUpload/readOnly. */
  readOnly?: boolean
}

function ExtractedRequirementsSection({
  run,
  onRunUpdated,
  readOnly = false,
}: ExtractedRequirementsSectionProps) {
  // savedText tracks the last-known-persisted value (from the run prop,
  // then from each successful save) — comparing against it, not the
  // initial value, is what lets the Save button re-disable after a save
  // and re-enable on the next edit.
  const [text, setText] = useState(run.extracted_requirements ?? '')
  const [savedText, setSavedText] = useState(run.extracted_requirements ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const hasChanges = text !== savedText

  async function handleSave() {
    if (!hasChanges) return
    setIsSaving(true)
    setSaveError(null)
    try {
      const response = await apiClient.put<Run>(`/runs/${run.run_id}/requirements`, {
        extracted_requirements: text,
      })
      setText(response.data.extracted_requirements ?? '')
      setSavedText(response.data.extracted_requirements ?? '')
      onRunUpdated(response.data)
    } catch (err) {
      setSaveError(extractErrorMessage(err, 'Failed to save requirements.'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <CollapsibleSection label="Requirements Text">
      <div className="flex flex-col gap-3">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          readOnly={readOnly}
          rows={12}
          placeholder="No text yet — see Source Files above, or paste/type requirements here…"
          className="max-h-96 min-h-[12rem] w-full resize-y rounded-lg border border-white/10 bg-void/30 p-3 font-mono text-sm text-white/80 outline-none placeholder:text-white/30 focus:border-indigo focus:ring-1 focus:ring-indigo disabled:cursor-not-allowed disabled:opacity-60 read-only:cursor-default read-only:opacity-60"
        />

        {!readOnly && saveError && <p className="text-sm text-red-400">{saveError}</p>}

        {!readOnly && (
          <button
            type="button"
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
            className="self-end rounded-md border border-white/10 bg-glass px-4 py-2 text-sm text-white/80 transition-colors hover:border-indigo/40 hover:text-indigo disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
    </CollapsibleSection>
  )
}

interface DivisionSectionProps {
  run: Run
  onDivisionApproved: () => Promise<void>
  /** Locked when Breakdown is being viewed as a historical revisit — see
   *  RunContent's showBreakdown. Strips every mutating control (add/
   *  delete/merge/edit/approve) down to a plain read of run.story_division. */
  readOnly?: boolean
}

function needsClarification(item: StoryDivisionItem): boolean {
  return item.summary.startsWith('[NEEDS CLARIFICATION]')
}

interface MergePreview {
  sourceItems: StoryDivisionItem[]
  title: string
  summary: string
}

interface DivisionItemCardProps {
  item: StoryDivisionItem
  /** Position in the visible list — drives the display-only "1", "2", "3"…
   *  badge. Never used for keys/merge/delete/persistence; item.id (the
   *  real DIV-00N) still owns all of that, unchanged. */
  index: number
  isSelected: boolean
  isFlagged: boolean
  isJustMerged: boolean
  onToggleSelected: () => void
  onUpdate: (patch: Partial<StoryDivisionItem>) => void
  /** Opens the shared delete-confirmation modal — does NOT delete
   *  directly; actual removal only happens if the PO confirms there. */
  onRequestDelete: () => void
  /** Strips selection, delete, and title/summary editing down to plain
   *  display — see DivisionSectionProps' own readOnly. */
  readOnly?: boolean
}

// Its own component (not inlined in DivisionSection's .map()) specifically
// so its several bits of local state (edit mode, overflow, save-flash…)
// can be per-card — a hook called from inside a bare .map() callback (not
// a real component boundary) would violate the rules of hooks.
function DivisionItemCard({
  item,
  index,
  isSelected,
  isFlagged,
  isJustMerged,
  onToggleSelected,
  onUpdate,
  onRequestDelete,
  readOnly = false,
}: DivisionItemCardProps) {
  const [isTitleEditing, setIsTitleEditing] = useState(false)
  const [isSummaryEditing, setIsSummaryEditing] = useState(false)
  // Read-mode only: clamped (2-line) vs fully expanded. Independent of
  // edit mode — editing always shows the full text regardless.
  const [isSummaryExpanded, setIsSummaryExpanded] = useState(false)
  const [isSummaryOverflowing, setIsSummaryOverflowing] = useState(false)
  const [titleJustSaved, flashTitleSaved] = useSavedFlash()
  const [summaryJustSaved, flashSummarySaved] = useSavedFlash()

  const titleInputRef = useRef<HTMLInputElement>(null)
  const summaryPreviewRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    if (!isTitleEditing) return
    const el = titleInputRef.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [isTitleEditing])

  // Overflow detection for the clamped summary: scrollHeight is the full
  // (unclamped) content height, clientHeight is the visible clamped box —
  // scrollHeight > clientHeight means -webkit-line-clamp is actually
  // cutting text off, so only then does "Show more" earn a place. Only
  // meaningful while collapsed and not editing (both skip past
  // line-clamp-2 entirely, so the comparison would be trivially equal).
  // Re-checked on resize (debounced) since line-wrapping is viewport-width
  // dependent.
  useEffect(() => {
    if (isSummaryEditing || isSummaryExpanded) return

    function checkOverflow() {
      const el = summaryPreviewRef.current
      if (!el) return
      setIsSummaryOverflowing(el.scrollHeight > el.clientHeight + 1)
    }
    checkOverflow()

    let resizeTimeout: ReturnType<typeof setTimeout>
    function handleResize() {
      clearTimeout(resizeTimeout)
      resizeTimeout = setTimeout(checkOverflow, 150)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      clearTimeout(resizeTimeout)
      window.removeEventListener('resize', handleResize)
    }
  }, [item.summary, isSummaryEditing, isSummaryExpanded])

  return (
    <div
      className={`relative rounded-xl border p-3 transition-all duration-150 ${
        isSelected
          ? 'border-indigo/50 bg-indigo/10 ring-1 ring-indigo/50'
          : 'border-white/15 bg-glass hover:-translate-y-0.5 hover:border-white/25 hover:shadow-lg hover:shadow-black/20'
      } ${isFlagged ? 'border-l-4 border-l-amber' : ''} ${isJustMerged ? 'animate-merge-glow' : ''}`}
    >
      {!readOnly && (
        <button
          type="button"
          onClick={onRequestDelete}
          aria-label={`Delete ${item.id}`}
          title="Delete"
          className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-md bg-clay/5 text-clay/70 transition-colors hover:bg-clay hover:text-white"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      )}

      <div className="flex items-center gap-2">
        {!readOnly && (
          <Checkbox checked={isSelected} onChange={onToggleSelected} label={`Select ${item.id}`} />
        )}
        <span
          title={item.id}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-indigo/30 bg-glass font-mono text-[11px] text-indigo"
        >
          {index + 1}
        </span>
        <span className="font-mono text-[10px] text-white/30">{item.id}</span>
      </div>

      {readOnly ? (
        <p className="-mx-1 mt-2 block w-full px-1 text-left font-display text-base font-semibold text-white">
          {item.title || <span className="text-white/30">(untitled)</span>}
        </p>
      ) : isTitleEditing ? (
        <input
          ref={titleInputRef}
          type="text"
          value={item.title}
          onChange={(event) => onUpdate({ title: event.target.value })}
          onBlur={() => {
            setIsTitleEditing(false)
            flashTitleSaved()
          }}
          placeholder="Title"
          className="-mx-1 mt-2 block w-full rounded border-b border-dashed border-indigo bg-transparent px-1 font-display text-base font-semibold text-white outline-none placeholder:text-white/30"
        />
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsTitleEditing(true)}
            className="-mx-1 block w-full cursor-text rounded px-1 py-0.5 text-left font-display text-base font-semibold text-white transition-colors hover:bg-white/5"
          >
            {item.title || <span className="text-white/30">Title — click to add</span>}
          </button>
          {titleJustSaved && <span className="shrink-0 text-xs text-teal">Saved</span>}
        </div>
      )}

      {readOnly ? (
        <p
          ref={summaryPreviewRef}
          className={`-mx-1 mt-2 px-1 text-sm leading-relaxed text-slate-300 ${
            isSummaryExpanded ? '' : 'line-clamp-2'
          }`}
        >
          {item.summary || <span className="text-white/30">(no summary)</span>}
        </p>
      ) : isSummaryEditing ? (
        <AutoGrowTextarea
          value={item.summary}
          onChange={(event) => onUpdate({ summary: event.target.value })}
          onBlur={() => {
            setIsSummaryEditing(false)
            flashSummarySaved()
          }}
          placeholder="Summary"
          autoFocus
          className="-mx-1 mt-2 w-full rounded border-b border-dashed border-indigo bg-transparent px-1 text-sm leading-relaxed text-slate-300 outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setIsSummaryEditing(true)}
          className="-mx-1 mt-2 block w-full cursor-text rounded px-1 py-0.5 text-left transition-colors hover:bg-white/5"
        >
          <p
            ref={summaryPreviewRef}
            className={`text-sm leading-relaxed text-slate-300 ${isSummaryExpanded ? '' : 'line-clamp-2'}`}
          >
            {item.summary || <span className="text-white/30">Summary — click to add</span>}
          </p>
        </button>
      )}
      {/* "Show more"/"Saved" trailing row: still shown read-only (purely
          expand/collapse, not an edit), just never carries summaryJustSaved
          since nothing ever sets that flag in read-only mode. */}
      {(isSummaryOverflowing || summaryJustSaved) && (
        <div className="mt-1 flex items-center gap-3">
          {isSummaryOverflowing && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setIsSummaryExpanded((expanded) => !expanded)
              }}
              className="text-xs font-medium text-indigo transition-colors hover:text-indigo/80"
            >
              {isSummaryExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
          {summaryJustSaved && <span className="text-xs text-teal">Saved</span>}
        </div>
      )}
    </div>
  )
}

function DivisionSection({ run, onDivisionApproved, readOnly = false }: DivisionSectionProps) {
  // editableDivision only matters while genuinely editable — in readOnly
  // mode (viewing this as a historical revisit after DIVISION_APPROVED)
  // every card renders straight from run.story_division via this same
  // state, just never mutated, since none of the controls that would
  // call setEditableDivision are reachable when readOnly.
  const [editableDivision, setEditableDivision] = useState<StoryDivisionItem[]>(
    () => run.story_division,
  )
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null)
  // Shared by both single-item delete (the trash icon on a card) and bulk
  // delete ("Delete N Selected") — populated with whichever item(s) are
  // pending confirmation; null means the modal is closed. Actual removal
  // from editableDivision only happens in confirmDelete().
  const [deleteTargets, setDeleteTargets] = useState<StoryDivisionItem[] | null>(null)
  const [justMergedId, setJustMergedId] = useState<string | null>(null)
  const [isApproving, setIsApproving] = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)
  const tempIdCounterRef = useRef(0)
  const mergeGlowTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (mergeGlowTimeoutRef.current) clearTimeout(mergeGlowTimeoutRef.current)
    }
  }, [])

  function updateItem(id: string, patch: Partial<StoryDivisionItem>) {
    setEditableDivision((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    )
  }

  function requestDeleteSingle(id: string) {
    const item = editableDivision.find((candidate) => candidate.id === id)
    if (!item) return
    setDeleteTargets([item])
  }

  function requestDeleteSelected() {
    // Filter (list order), same rationale as openMergePreview — the modal
    // should list them the way they appear on screen, not click order.
    const items = editableDivision.filter((item) => selectedIds.has(item.id))
    if (items.length === 0) return
    setDeleteTargets(items)
  }

  function cancelDelete() {
    // No selection-clearing here: cancelling a bulk delete should leave
    // the PO's selection exactly as it was, same as cancelMergePreview.
    setDeleteTargets(null)
  }

  function confirmDelete() {
    if (!deleteTargets) return
    const idsToDelete = new Set(deleteTargets.map((item) => item.id))
    setEditableDivision((items) => items.filter((item) => !idsToDelete.has(item.id)))
    // Drop any deleted ids from the selection too, so a stale id never
    // lingers in selectedIds referencing an item that no longer exists.
    setSelectedIds((ids) => {
      const next = new Set(ids)
      let changed = false
      for (const id of idsToDelete) {
        if (next.delete(id)) changed = true
      }
      return changed ? next : ids
    })
    setDeleteTargets(null)
  }

  function addItem() {
    tempIdCounterRef.current += 1
    setEditableDivision((items) => [
      ...items,
      {
        id: `DIV-NEW-${tempIdCounterRef.current}`,
        title: '',
        summary: '',
        source_refs: [],
        extra_attachments: [],
      },
    ])
  }

  function toggleSelected(id: string) {
    setSelectedIds((ids) => {
      const next = new Set(ids)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function clearSelection() {
    setSelectedIds(new Set())
  }

  function openMergePreview() {
    // Filter (not the click order) so "first selected" means first in
    // list order — deterministic regardless of click sequence.
    const selected = editableDivision.filter((item) => selectedIds.has(item.id))
    if (selected.length < 2) return
    setMergePreview({
      sourceItems: selected,
      title: selected[0].title,
      summary: selected.map((item) => item.summary).join('\n\n'),
    })
  }

  function cancelMergePreview() {
    // Selection deliberately stays as-is — the PO can tweak it (add/remove
    // a card from the selection) and reopen the preview without starting
    // over.
    setMergePreview(null)
  }

  function confirmMerge() {
    if (!mergePreview) return
    const { sourceItems, title, summary } = mergePreview
    const [primary, ...rest] = sourceItems
    const restIds = new Set(rest.map((item) => item.id))
    const mergedSourceRefs = Array.from(new Set(sourceItems.flatMap((item) => item.source_refs)))
    const merged: StoryDivisionItem = {
      ...primary,
      title,
      summary,
      source_refs: mergedSourceRefs,
    }

    setEditableDivision((items) =>
      items
        .map((item) => (item.id === primary.id ? merged : item))
        .filter((item) => !restIds.has(item.id)),
    )
    setSelectedIds(new Set())
    setMergePreview(null)

    if (mergeGlowTimeoutRef.current) clearTimeout(mergeGlowTimeoutRef.current)
    setJustMergedId(merged.id)
    mergeGlowTimeoutRef.current = setTimeout(() => setJustMergedId(null), 1800)
  }

  async function handleApprove() {
    if (editableDivision.length === 0) return
    setIsApproving(true)
    setApproveError(null)
    try {
      // PUT /division stores whatever ids are sent as-is — it does not
      // reassign them server-side — so renumber sequentially here before
      // submitting rather than persisting client-side temp ids like
      // "DIV-NEW-1".
      const payload = editableDivision.map((item, index) => ({
        ...item,
        id: `DIV-${String(index + 1).padStart(3, '0')}`,
      }))
      await apiClient.put(`/runs/${run.run_id}/division`, { story_division: payload })
      await onDivisionApproved()
    } catch (err) {
      setApproveError(extractErrorMessage(err, 'Failed to approve division.'))
    } finally {
      setIsApproving(false)
    }
  }

  return (
    <>
      <div className="flex max-w-7xl flex-col gap-6">
        {/* No card wrapper here either — same treatment as the Upload
            header above (and Write Stories/Review/Publish's own headers):
            bottom border only, no bordered/bg box. */}
        <div className="border-b border-white/10 pb-6">
          <PhaseBreadcrumb status={run.status} forceStepIndex={1} />
          <div className="flex flex-wrap items-center gap-2">
            <SignalBadge status={run.status} />
            {readOnly && <ReadOnlyBadge />}
            <span className="rounded-full border border-white/10 bg-glass px-3 py-1 font-mono text-xs text-white/50">
              {editableDivision.length} item{editableDivision.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-indigo/40 bg-glass shadow-[0_0_16px_rgba(124,111,242,0.25)]">
                <Layers className="h-5 w-5 text-indigo" strokeWidth={2} />
              </div>
              <h1 className="bg-gradient-to-r from-indigo to-teal bg-clip-text font-display text-2xl font-semibold text-transparent">
                Division Review
              </h1>
            </div>

            {!readOnly && (
              <button
                type="button"
                onClick={handleApprove}
                disabled={isApproving || editableDivision.length === 0}
                className="shrink-0 rounded-md bg-indigo px-6 py-3 text-sm font-medium text-white shadow-lg shadow-indigo/30 transition-shadow hover:shadow-indigo/50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isApproving ? (
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
                    Approving…
                  </span>
                ) : (
                  'Approve Story Breakdown'
                )}
              </button>
            )}
          </div>
        </div>

        {!readOnly && approveError && <p className="text-red-400">{approveError}</p>}

        <CollapsibleSection label={`Division Items (${editableDivision.length})`}>
        <div className="flex flex-col gap-3">
          {!readOnly && selectedIds.size >= 2 && (
            <div className="sticky top-2 z-10 mb-1 flex flex-wrap items-center gap-2 rounded-lg border border-indigo/40 bg-abyss/90 px-3 py-2 shadow-lg shadow-black/30 backdrop-blur-md">
              <span className="mr-auto font-mono text-xs text-white/60">{selectedIds.size} selected</span>
              <button
                type="button"
                onClick={openMergePreview}
                className="rounded-md bg-indigo px-3 py-1.5 text-xs font-medium text-white shadow shadow-indigo/30 transition-shadow hover:shadow-indigo/50"
              >
                Merge {selectedIds.size} Selected
              </button>
              <button
                type="button"
                onClick={requestDeleteSelected}
                className="rounded-md border border-clay/40 bg-clay/5 px-3 py-1.5 text-xs font-medium text-clay/80 transition-colors hover:bg-clay hover:text-white"
              >
                Delete {selectedIds.size} Selected
              </button>
              <button
                type="button"
                onClick={clearSelection}
                aria-label="Clear selection"
                title="Cancel"
                className="rounded px-1.5 text-white/40 transition-colors hover:text-white"
              >
                ×
              </button>
            </div>
          )}

          {editableDivision.map((item, index) => (
            <DivisionItemCard
              key={item.id}
              item={item}
              index={index}
              isSelected={selectedIds.has(item.id)}
              isFlagged={needsClarification(item)}
              isJustMerged={item.id === justMergedId}
              onToggleSelected={() => toggleSelected(item.id)}
              onUpdate={(patch) => updateItem(item.id, patch)}
              onRequestDelete={() => requestDeleteSingle(item.id)}
              readOnly={readOnly}
            />
          ))}

          {!readOnly && (
            <button
              type="button"
              onClick={addItem}
              className="self-start rounded-md border border-white/10 bg-glass px-4 py-2 text-sm text-white/70 transition-colors hover:border-indigo/40 hover:text-indigo"
            >
              + Add Story
            </button>
          )}
        </div>
        </CollapsibleSection>
      </div>

      {mergePreview && (
        <MergePreviewModal
          preview={mergePreview}
          onTitleChange={(title) =>
            setMergePreview((current) => (current ? { ...current, title } : current))
          }
          onSummaryChange={(summary) =>
            setMergePreview((current) => (current ? { ...current, summary } : current))
          }
          onCancel={cancelMergePreview}
          onConfirm={confirmMerge}
        />
      )}

      {deleteTargets && (
        <DeleteConfirmModal items={deleteTargets} onCancel={cancelDelete} onConfirm={confirmDelete} />
      )}
    </>
  )
}

interface MergePreviewModalProps {
  preview: MergePreview
  onTitleChange: (title: string) => void
  onSummaryChange: (summary: string) => void
  onCancel: () => void
  onConfirm: () => void
}

function MergePreviewModal({
  preview,
  onTitleChange,
  onSummaryChange,
  onCancel,
  onConfirm,
}: MergePreviewModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
      {/* max-h caps the modal itself; flex-col + the body's min-h-0 (a
          classic flexbox gotcha — a flex-1 child defaults to min-height:
          auto, which lets it grow past the parent instead of scrolling)
          are what let the body actually scroll instead of the modal (or
          the whole page) just growing past the viewport with an 11+ item
          merge. */}
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-indigo/30 bg-abyss shadow-2xl shadow-black/50">
        <div className="shrink-0 border-b border-white/10 px-5 pb-4 pt-5">
          <h2 className="font-display text-lg font-semibold text-white">
            Merge {preview.sourceItems.length} Items
          </h2>
          <p className="mt-1 text-xs text-white/50">
            Review and edit the combined item before confirming — nothing is changed yet.
          </p>
        </div>

        <div className="themed-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-void/30 p-2.5">
            {preview.sourceItems.map((item) => (
              <div key={item.id} className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 rounded-full border border-indigo/30 bg-glass px-1.5 py-0.5 font-mono text-indigo">
                  {item.id}
                </span>
                <span className="truncate text-white/50">{item.title || '(untitled)'}</span>
              </div>
            ))}
          </div>

          <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-white/50">
            Merged Title
          </label>
          <input
            type="text"
            value={preview.title}
            onChange={(event) => onTitleChange(event.target.value)}
            className="mt-1 block w-full rounded-md border border-white/10 bg-void/40 p-2 font-display text-sm font-semibold text-white outline-none focus:border-indigo focus:ring-1 focus:ring-indigo"
          />

          <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-white/50">
            Merged Summary
          </label>
          <AutoGrowTextarea
            value={preview.summary}
            onChange={(event) => onSummaryChange(event.target.value)}
            rows={4}
            className="mt-1 w-full rounded-md border border-white/10 bg-void/40 p-2 text-sm text-white/80 outline-none focus:border-indigo focus:ring-1 focus:ring-indigo"
          />
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-white/10 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-white/10 px-4 py-2 text-sm text-white/70 transition-colors hover:border-white/25 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-indigo px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo/30 transition-shadow hover:shadow-indigo/50"
          >
            Confirm Merge
          </button>
        </div>
      </div>
    </div>
  )
}

interface DeleteConfirmModalProps {
  items: StoryDivisionItem[]
  onCancel: () => void
  onConfirm: () => void
}

// Same panel structure/sizing as MergePreviewModal (scoped modal, capped
// height, scrollable item list, pinned footer) — deliberately reused
// rather than a bespoke design, so the two confirmation flows feel like
// one consistent pattern, just clay-tinted here instead of indigo since
// this one is destructive.
function DeleteConfirmModal({ items, onCancel, onConfirm }: DeleteConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-clay/30 bg-abyss shadow-2xl shadow-black/50">
        <div className="shrink-0 border-b border-white/10 px-5 pb-4 pt-5">
          <h2 className="font-display text-lg font-semibold text-white">
            Delete {items.length} Item{items.length === 1 ? '' : 's'}
          </h2>
          <p className="mt-1 text-xs text-white/50">
            Review what's being removed before confirming — this only affects your local edits
            until you approve the breakdown.
          </p>
        </div>

        <div className="themed-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-void/30 p-2.5">
            {items.map((item) => (
              <div key={item.id} className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 rounded-full border border-clay/30 bg-glass px-1.5 py-0.5 font-mono text-clay">
                  {item.id}
                </span>
                <span className="truncate text-white/50">{item.title || '(untitled)'}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-white/10 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-white/10 px-4 py-2 text-sm text-white/70 transition-colors hover:border-white/25 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-clay px-4 py-2 text-sm font-medium text-white shadow-lg shadow-clay/30 transition-shadow hover:shadow-clay/50"
          >
            Confirm Delete
          </button>
        </div>
      </div>
    </div>
  )
}

interface ApprovedDivisionListProps {
  run: Run
  onRunUpdated: (run: Run) => void
  onContinueToReview: () => void
  defaultPrompts: DefaultPrompts | null
}

function findGeneratedStory(run: Run, divisionItemId: string): UserStory | undefined {
  return run.user_stories.find((story) => story.source_division_item_id === divisionItemId)
}

// The Write Stories step. Used to also own Review/Publish (via a local
// showReview toggle) before those became real, separate steps — now it's
// purely this one, and onContinueToReview just hands off to RunPage.
function ApprovedDivisionList({
  run,
  onRunUpdated,
  onContinueToReview,
  defaultPrompts,
}: ApprovedDivisionListProps) {
  // Set, not a single id: multiple cards can be generating concurrently
  // (each card's button is independent per the spec), so a single
  // "current generating id" would wipe one card's loading state whenever
  // another card started generating. Generate All still only ever adds one
  // id at a time in practice (it awaits each call before starting the
  // next), so the exact same per-card indicator this drives already reads
  // as "one at a time" with no extra plumbing needed for that part.
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set())
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({})
  const [isGeneratingAll, setIsGeneratingAll] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(
    null,
  )
  // Modal-driven confirm for "Continue to Review" when clicked with items
  // still ungenerated — same pattern as deleteTargets in DivisionSection:
  // null means the modal is closed; a populated array is both "modal is
  // open" and "here's exactly what it should list", set once at click
  // time so it doesn't shift under the PO while the modal is up.
  const [pendingItemsForContinue, setPendingItemsForContinue] = useState<StoryDivisionItem[] | null>(
    null,
  )
  // null = the detail panel is closed. Unlike the old permanent two-column
  // layout, nothing is auto-selected on mount — the table itself is the
  // primary view now; the panel only opens on an explicit click.
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)

  // Table-row "attach" icon: one shared hidden file input (not one per row)
  // — openAttachPicker stashes which row it's for in a ref (a plain ref,
  // not state, since it only needs to be read later inside the input's own
  // onChange, by which point any state update would long since have
  // flushed anyway) then clicks the input, same "click a hidden input"
  // trick as HomePage's dropzone.
  const attachInputRef = useRef<HTMLInputElement>(null)
  const uploadTargetItemIdRef = useRef<string | null>(null)
  const [uploadingAttachmentIds, setUploadingAttachmentIds] = useState<Set<string>>(new Set())
  const [attachmentErrors, setAttachmentErrors] = useState<Record<string, string>>({})

  async function handleGenerateStory(itemId: string) {
    setGeneratingIds((ids) => new Set(ids).add(itemId))
    setCardErrors(({ [itemId]: _removed, ...rest }) => rest)

    try {
      const response = await apiClient.post<Run>(`/runs/${run.run_id}/stories/${itemId}`)
      onRunUpdated(response.data)
    } catch (err) {
      setCardErrors((errors) => ({
        ...errors,
        [itemId]: extractErrorMessage(err, 'Failed to generate story.'),
      }))
    } finally {
      setGeneratingIds((ids) => {
        const next = new Set(ids)
        next.delete(itemId)
        return next
      })
    }
  }

  async function handleGenerateAll() {
    // Snapshot decision, made once at click time — each iteration still
    // independently POSTs and folds the result back in via onRunUpdated,
    // same as clicking each card's button in sequence by hand would.
    const pendingIds = run.story_division
      .filter((item) => !findGeneratedStory(run, item.id))
      .map((item) => item.id)
    if (pendingIds.length === 0) return

    setIsGeneratingAll(true)
    const total = pendingIds.length
    try {
      for (let i = 0; i < pendingIds.length; i++) {
        setBatchProgress({ current: i + 1, total })
        // Deliberately awaited one at a time, not Promise.all'd — matches
        // the one-at-a-time approach for quality/failure isolation.
        // handleGenerateStory already catches its own errors into
        // cardErrors rather than throwing, so one failure doesn't abort
        // the loop; it just moves on to the next item.
        await handleGenerateStory(pendingIds[i])
      }
    } finally {
      setBatchProgress(null)
      setIsGeneratingAll(false)
    }
  }

  // Reuses the existing bulk /division endpoint (normally the Approve
  // Division action) rather than adding a new per-item PUT endpoint —
  // sends the whole story_division array back with just this one item
  // patched. Re-setting the same DIVISION_APPROVED status server-side is
  // harmless/idempotent since that's already the run's current status
  // here.
  async function handleSaveDivisionItem(itemId: string, patch: Partial<StoryDivisionItem>) {
    const updatedDivision = run.story_division.map((item) =>
      item.id === itemId ? { ...item, ...patch } : item,
    )
    const response = await apiClient.put<Run>(`/runs/${run.run_id}/division`, {
      story_division: updatedDivision,
    })
    onRunUpdated(response.data)
  }

  function openAttachPicker(itemId: string) {
    uploadTargetItemIdRef.current = itemId
    attachInputRef.current?.click()
  }

  async function handleAttachFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    const itemId = uploadTargetItemIdRef.current
    // Live FileList must be copied before the input resets below, same
    // caveat as HomePage's handleFilesPicked.
    const picked = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!itemId || picked.length === 0) return

    setUploadingAttachmentIds((ids) => new Set(ids).add(itemId))
    setAttachmentErrors(({ [itemId]: _removed, ...rest }) => rest)
    const formData = new FormData()
    for (const file of picked) {
      formData.append('files', file)
    }
    try {
      const response = await apiClient.post<Run>(
        `/runs/${run.run_id}/division/${itemId}/attachments`,
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      )
      onRunUpdated(response.data)
    } catch (err) {
      setAttachmentErrors((errors) => ({
        ...errors,
        [itemId]: extractErrorMessage(err, 'Failed to upload attachment.'),
      }))
    } finally {
      setUploadingAttachmentIds((ids) => {
        const next = new Set(ids)
        next.delete(itemId)
        return next
      })
    }
  }

  const totalCount = run.story_division.length
  const generatedCount = run.story_division.filter((item) => findGeneratedStory(run, item.id)).length
  const allGenerated = totalCount > 0 && generatedCount === totalCount
  const selectedItem = run.story_division.find((item) => item.id === selectedItemId)

  function handleContinueClick() {
    if (allGenerated) {
      onContinueToReview()
      return
    }
    const pendingItems = run.story_division.filter((item) => !findGeneratedStory(run, item.id))
    setPendingItemsForContinue(pendingItems)
  }

  function cancelContinuePrompt() {
    setPendingItemsForContinue(null)
  }

  function confirmContinueAnyway() {
    setPendingItemsForContinue(null)
    onContinueToReview()
  }

  return (
    <div className="flex max-w-7xl flex-col gap-6">
      {/* No card here on purpose — breadcrumb/heading/actions sit directly
          on the page background, same as the reference. A bottom border
          (not a full bordered box) is what separates this from the table
          below. */}
      <div className="border-b border-white/10 pb-6">
        <PhaseBreadcrumb status={run.status} approvedPhase="write" />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-indigo/40 bg-glass shadow-[0_0_16px_rgba(124,111,242,0.25)]">
              <EditIcon className="h-5 w-5 text-indigo" />
            </div>
            <div>
              <h1 className="bg-gradient-to-r from-indigo to-teal bg-clip-text font-display text-2xl font-semibold text-transparent">
                Write Stories
              </h1>
              <p className="mt-1 font-mono text-sm text-white/50">
                {generatedCount} of {totalCount} generated
              </p>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-end gap-3">
            {!allGenerated && (
              <div className="flex items-center gap-2">
                <PromptOverrideButton
                  runId={run.run_id}
                  run={run}
                  field="story"
                  defaultPrompts={defaultPrompts}
                  onRunUpdated={onRunUpdated}
                />
                <div className="flex flex-col items-end gap-1.5">
                  <button
                    type="button"
                    onClick={handleGenerateAll}
                    disabled={isGeneratingAll}
                    className="rounded-md bg-indigo px-6 py-3 text-sm font-medium text-white shadow-lg shadow-indigo/30 transition-shadow hover:shadow-indigo/50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isGeneratingAll ? (
                      <span className="flex items-center gap-2">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
                        Generating…
                      </span>
                    ) : (
                      'Generate All'
                    )}
                  </button>
                  {batchProgress && (
                    <span className="font-mono text-xs text-white/50">
                      Generating {batchProgress.current} of {batchProgress.total}…
                    </span>
                  )}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={handleContinueClick}
              className="shrink-0 rounded-md bg-teal px-6 py-3 text-sm font-medium text-void shadow-lg shadow-teal/30 transition-shadow hover:shadow-teal/50"
            >
              Continue to Review
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-white/15 bg-glass backdrop-blur-md">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 font-mono text-[10px] uppercase tracking-wide text-white/40">
              <th className="px-4 py-3 font-medium">ID</th>
              <th className="px-4 py-3 font-medium">Title</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {run.story_division.map((item) => {
              const story = findGeneratedStory(run, item.id)
              const isGenerating = generatingIds.has(item.id)
              const isFlagged = story
                ? story.acceptance_criteria.some((ac) => ac.startsWith('[NEEDS CLARIFICATION]'))
                : needsClarification(item)

              return (
                <tr
                  key={item.id}
                  onClick={() => setSelectedItemId(item.id)}
                  className="cursor-pointer border-b border-white/5 transition-colors last:border-0 hover:bg-white/5"
                >
                  <td className="px-4 py-3 font-mono text-xs text-indigo">{item.id}</td>
                  <td className="px-4 py-3 text-white/90">{item.title || '(untitled)'}</td>
                  <td className="px-4 py-3">
                    {story ? (
                      <span className="rounded border border-white/15 px-1.5 py-0.5 font-mono text-[10px] uppercase text-white/60">
                        {story.story_type}
                      </span>
                    ) : (
                      <span className="text-white/20">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <RowStatusBadge isGenerating={isGenerating} isGenerated={!!story} isFlagged={isFlagged} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <div className="relative shrink-0">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            openAttachPicker(item.id)
                          }}
                          disabled={uploadingAttachmentIds.has(item.id)}
                          title={
                            attachmentErrors[item.id] ??
                            (item.extra_attachments.length > 0
                              ? `${item.extra_attachments.length} extra file${
                                  item.extra_attachments.length === 1 ? '' : 's'
                                } attached — click to add more`
                              : 'Attach supplementary files')
                          }
                          className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            attachmentErrors[item.id]
                              ? 'border-red-400/50 text-red-400 hover:border-red-400'
                              : 'border-white/15 text-white/60 hover:border-indigo/40 hover:text-indigo'
                          }`}
                        >
                          {uploadingAttachmentIds.has(item.id) ? (
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo" />
                          ) : (
                            <PaperclipIcon className="h-3.5 w-3.5" />
                          )}
                        </button>
                        {item.extra_attachments.length > 0 && (
                          <span className="pointer-events-none absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-abyss bg-indigo px-1 font-mono text-[9px] font-medium leading-none text-white">
                            {item.extra_attachments.length}
                          </span>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          if (story) {
                            setSelectedItemId(item.id)
                          } else {
                            handleGenerateStory(item.id)
                          }
                        }}
                        disabled={isGenerating}
                        className={
                          story
                            ? 'rounded-md border border-white/15 px-3 py-1.5 text-xs font-medium text-white/70 transition-colors hover:border-indigo/40 hover:text-indigo'
                            : 'rounded-md bg-indigo px-3 py-1.5 text-xs font-medium text-white shadow shadow-indigo/30 transition-shadow hover:shadow-indigo/50 disabled:cursor-not-allowed disabled:opacity-60'
                        }
                      >
                        {isGenerating ? 'Generating…' : story ? 'View' : 'Generate'}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <input
        ref={attachInputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPTED_EXTENSIONS}
        onChange={handleAttachFilesPicked}
        className="hidden"
      />

      {selectedItem && (
        <StoryDetailPanel
          key={selectedItem.id}
          item={selectedItem}
          story={findGeneratedStory(run, selectedItem.id)}
          isGenerating={generatingIds.has(selectedItem.id)}
          cardError={cardErrors[selectedItem.id]}
          runId={run.run_id}
          onGenerate={() => handleGenerateStory(selectedItem.id)}
          onRunUpdated={onRunUpdated}
          onSaveDivisionItem={(patch) => handleSaveDivisionItem(selectedItem.id, patch)}
          onClose={() => setSelectedItemId(null)}
        />
      )}

      {pendingItemsForContinue && (
        <ContinueAnywayModal
          items={pendingItemsForContinue}
          onCancel={cancelContinuePrompt}
          onConfirm={confirmContinueAnyway}
        />
      )}
    </div>
  )
}

interface ContinueAnywayModalProps {
  items: StoryDivisionItem[]
  onCancel: () => void
  onConfirm: () => void
}

// Same panel structure/sizing as MergePreviewModal/DeleteConfirmModal
// (scoped modal, capped height, scrollable item list, pinned footer) —
// reused rather than a bespoke inline confirm, so this reads as the same
// pattern as the other two confirmation flows. Teal-tinted (not
// clay/destructive) since continuing isn't a destructive action, and
// matches the teal "Continue to Review" button that triggers it.
function ContinueAnywayModal({ items, onCancel, onConfirm }: ContinueAnywayModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-teal/30 bg-abyss shadow-2xl shadow-black/50">
        <div className="shrink-0 border-b border-white/10 px-5 pb-4 pt-5">
          <h2 className="font-display text-lg font-semibold text-white">
            {items.length} Item{items.length === 1 ? '' : 's'} Without a Story
          </h2>
          <p className="mt-1 text-xs text-white/50">
            {items.length === 1
              ? "This item doesn't have a generated story yet."
              : "These items don't have generated stories yet."}{' '}
            You can still continue to review, or cancel and generate them first.
          </p>
        </div>

        <div className="themed-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-void/30 p-2.5">
            {items.map((item) => (
              <div key={item.id} className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 rounded-full border border-indigo/30 bg-glass px-1.5 py-0.5 font-mono text-indigo">
                  {item.id}
                </span>
                <span className="truncate text-white/50">{item.title || '(untitled)'}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-white/10 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-white/10 px-4 py-2 text-sm text-white/70 transition-colors hover:border-white/25 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-teal px-4 py-2 text-sm font-medium text-void shadow-lg shadow-teal/30 transition-shadow hover:shadow-teal/50"
          >
            Continue Anyway
          </button>
        </div>
      </div>
    </div>
  )
}

interface ReviewViewProps {
  run: Run
  onRunUpdated: (run: Run) => void
  includedStoryIds: Set<string>
  onToggleIncludedStory: (storyId: string) => void
  publishFieldsByStoryId: Record<string, PublishFields>
  onUpdatePublishFields: (storyId: string, patch: Partial<PublishFields>) => void
  onContinueToPublish: () => void
}

interface ReviewableEntry {
  item: StoryDivisionItem
  story: UserStory
}

// The Review step: every division item that has a generated story, with a
// per-row "include in publish" checkbox (defaulted to all-checked by
// RunPage's handleContinueToReview) and a merged slide-over combining what
// used to be split across Write Stories' own panel (description/AC/
// story-type/regenerate) and the old per-story Publish panel (epic/
// priority/points/sprint/attachments/comment) — see ReviewStoryPanel.
// The Epic field itself is a SearchableSelect in search mode (see
// searchEpics below) — it queries GET /epics/search directly rather than
// this view fetching a list upfront, so unlike Project there's no
// epics/isLoadingEpics/epicsError state here at all. Accounts USED to be
// fetched once here too, same as Project below — but now that the
// target project is itself selectable per story (see ReviewStoryPanel's
// projectId-keyed fetch), which accounts are valid depends on that
// selection, so accounts moved to being fetched there instead, per
// project, rather than once globally here.
function ReviewView({
  run,
  onRunUpdated,
  includedStoryIds,
  onToggleIncludedStory,
  publishFieldsByStoryId,
  onUpdatePublishFields,
  onContinueToPublish,
}: ReviewViewProps) {
  const [projects, setProjects] = useState<RunProject[]>([])
  const [isLoadingProjects, setIsLoadingProjects] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [isBulkEditOpen, setIsBulkEditOpen] = useState(false)
  // Regenerate lives in this step's merged panel now (moved from Write
  // Stories' own panel) — same per-item generatingIds/cardErrors shape as
  // ApprovedDivisionList's, just local to this step since the two are
  // never on screen at the same time.
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set())
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({})

  // The project LIST itself (unlike per-project accounts/field
  // availability) isn't tied to any one selection — fetched once per
  // mount, no run.run_id dependency, same as accounts used to be.
  useEffect(() => {
    let cancelled = false
    setIsLoadingProjects(true)
    setProjectsError(null)
    apiClient
      .get<RunProject[]>('/projects', { headers: NO_CACHE_REQUEST_HEADERS })
      .then((response) => {
        if (!cancelled) setProjects(response.data)
      })
      .catch((err) => {
        if (!cancelled) setProjectsError(extractErrorMessage(err, 'Failed to load projects.'))
      })
      .finally(() => {
        if (!cancelled) setIsLoadingProjects(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleRegenerateStory(divisionItemId: string) {
    setGeneratingIds((ids) => new Set(ids).add(divisionItemId))
    setCardErrors(({ [divisionItemId]: _removed, ...rest }) => rest)
    try {
      const response = await apiClient.post<Run>(`/runs/${run.run_id}/stories/${divisionItemId}`)
      onRunUpdated(response.data)
    } catch (err) {
      setCardErrors((errors) => ({
        ...errors,
        [divisionItemId]: extractErrorMessage(err, 'Failed to regenerate story.'),
      }))
    } finally {
      setGeneratingIds((ids) => {
        const next = new Set(ids)
        next.delete(divisionItemId)
        return next
      })
    }
  }

  // Only items with a generated story can be reviewed/published — nothing
  // to show for one that never got a story (that's Write Stories' problem,
  // a screen back).
  const reviewableEntries: ReviewableEntry[] = run.story_division
    .map((item) => ({ item, story: findGeneratedStory(run, item.id) }))
    .filter((entry): entry is ReviewableEntry => !!entry.story)

  const selectedEntry = reviewableEntries.find((entry) => entry.item.id === selectedItemId)
  const selectedFields = selectedEntry
    ? publishFieldsByStoryId[selectedEntry.story.id] ?? {
        ...EMPTY_PUBLISH_FIELDS,
        epicKey: selectedEntry.story.epic_key ?? '',
        storyPoints: selectedEntry.story.story_points?.toString() ?? '',
      }
    : EMPTY_PUBLISH_FIELDS

  // Bulk Edit's target set — same Include checkboxes Continue to Publish
  // already reads, recomputed on every render rather than cached, so it's
  // never stale relative to a checkbox the PO just toggled.
  const includedEntries = reviewableEntries.filter((entry) => includedStoryIds.has(entry.story.id))

  return (
    <div className="flex max-w-7xl flex-col gap-6">
      <div className="border-b border-white/10 pb-6">
        <PhaseBreadcrumb status={run.status} approvedPhase="review" />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-indigo/40 bg-glass shadow-[0_0_16px_rgba(124,111,242,0.25)]">
              <EditIcon className="h-5 w-5 text-indigo" />
            </div>
            <div>
              <h1 className="bg-gradient-to-r from-indigo to-teal bg-clip-text font-display text-2xl font-semibold text-transparent">
                Review
              </h1>
              <p className="mt-1 font-mono text-sm text-white/50">
                {includedStoryIds.size} of {reviewableEntries.length} included
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {/* Same Include selection Continue to Publish reads — disabled
                with nothing checked since there'd be no target to apply
                to. */}
            <button
              type="button"
              onClick={() => setIsBulkEditOpen(true)}
              disabled={includedEntries.length === 0}
              className="shrink-0 rounded-md border border-white/15 bg-glass px-6 py-3 text-sm font-medium text-white/80 transition-colors hover:border-indigo/40 hover:text-indigo disabled:cursor-not-allowed disabled:opacity-40"
            >
              Bulk Edit
            </button>
            {/* No local "← Back" here anymore — the rail itself is
                clickable now (Write Stories included), which made this
                redundant. Continue to Publish stays enabled unconditionally
                — no validation blocking here, even with nothing checked or
                an item missing its epic. Validation (missing epic
                specifically) happens at actual publish time, on the next
                step. */}
            <button
              type="button"
              onClick={onContinueToPublish}
              className="shrink-0 rounded-md bg-teal px-6 py-3 text-sm font-medium text-void shadow-lg shadow-teal/30 transition-shadow hover:shadow-teal/50"
            >
              Continue to Publish
            </button>
          </div>
        </div>
      </div>

      {projectsError && <p className="text-sm text-red-400">{projectsError}</p>}

      <div className="overflow-x-auto rounded-xl border border-white/15 bg-glass backdrop-blur-md">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 font-mono text-[10px] uppercase tracking-wide text-white/40">
              <th className="px-4 py-3 font-medium">Include</th>
              <th className="px-4 py-3 font-medium">ID</th>
              <th className="px-4 py-3 font-medium">Title</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {reviewableEntries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-white/40">
                  No generated stories to review yet.
                </td>
              </tr>
            )}
            {reviewableEntries.map(({ item, story }) => (
              <tr
                key={item.id}
                onClick={() => setSelectedItemId(item.id)}
                className="cursor-pointer border-b border-white/5 transition-colors last:border-0 hover:bg-white/5"
              >
                <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    checked={includedStoryIds.has(story.id)}
                    onChange={() => onToggleIncludedStory(story.id)}
                    label={`Include ${item.id} in publish`}
                  />
                </td>
                <td className="px-4 py-3 font-mono text-xs text-indigo">{item.id}</td>
                <td className="px-4 py-3 text-white/90">{item.title || '(untitled)'}</td>
                <td className="px-4 py-3">
                  <span className="rounded border border-white/15 px-1.5 py-0.5 font-mono text-[10px] uppercase text-white/60">
                    {story.story_type}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      setSelectedItemId(item.id)
                    }}
                    className="rounded-md border border-white/15 px-3 py-1.5 text-xs font-medium text-white/70 transition-colors hover:border-indigo/40 hover:text-indigo"
                  >
                    View &amp; Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedEntry && (
        <ReviewStoryPanel
          key={selectedEntry.item.id}
          runId={run.run_id}
          item={selectedEntry.item}
          story={selectedEntry.story}
          isGenerating={generatingIds.has(selectedEntry.item.id)}
          cardError={cardErrors[selectedEntry.item.id]}
          onGenerate={() => handleRegenerateStory(selectedEntry.item.id)}
          onRunUpdated={onRunUpdated}
          projects={projects}
          isLoadingProjects={isLoadingProjects}
          fields={selectedFields}
          onFieldsChange={(patch) => onUpdatePublishFields(selectedEntry.story.id, patch)}
          onClose={() => setSelectedItemId(null)}
        />
      )}

      {isBulkEditOpen && (
        <BulkEditPanel
          runId={run.run_id}
          projects={projects}
          isLoadingProjects={isLoadingProjects}
          includedEntries={includedEntries}
          onUpdatePublishFields={onUpdatePublishFields}
          onRunUpdated={onRunUpdated}
          onClose={() => setIsBulkEditOpen(false)}
        />
      )}
    </div>
  )
}

interface ReviewStoryPanelProps {
  runId: string
  item: StoryDivisionItem
  story: UserStory
  isGenerating: boolean
  cardError: string | undefined
  onGenerate: () => void
  onRunUpdated: (run: Run) => void
  projects: RunProject[]
  isLoadingProjects: boolean
  fields: PublishFields
  onFieldsChange: (patch: Partial<PublishFields>) => void
  onClose: () => void
}

// The merged Review panel: story content (description/AC/story-type,
// editable, plus Regenerate) that used to live in Write Stories' own
// panel, and JIRA publish fields (epic/priority/points/sprint/comment)
// that used to live in the old per-story Publish panel — one panel
// instead of two separate ones a PO had to visit. No real Publish button
// here (confirmed): the bottom button is Save Changes — actual JIRA
// publishing stays a bulk action on the next step, not per-story from
// this panel.
//
// NOTHING in this panel persists anywhere until Save Changes is clicked
// — every field (description, AC rows/notes, story type, epic, priority,
// story points, sprint, comment) only ever touches local draft state
// while editing. That covers two different kinds of "persist" the old
// version conflated: description/AC/type go to the server via PUT
// /stories/{id}; epic/priority/points/sprint/comment go to RunPage's own
// publishFieldsByStoryId (fields/onFieldsChange prop — not a network
// call, but still a commit the PO didn't ask for yet if it happens on
// every keystroke, since that state survives closing/reopening this panel
// and feeds the actual bulk Publish step). Both kinds are buffered in
// local state (draftFields alongside localDescription/
// localAcceptanceCriteria/localStoryType/localNotes) and only pushed to
// their respective "real" homes inside handleSaveChanges, together, on a
// successful save. Closing without saving needs no explicit revert logic
// — since nothing was pushed anywhere during editing, unmounting (this
// component is remounted fresh per item via ReviewView's key={item.id})
// already discards the draft correctly by construction.
//
// Rendered as a CENTERED MODAL (fixed inset-0, flex items-center
// justify-center, dimmed backdrop, max-w-4xl/max-h-[90vh] panel with its
// own internal scroll) rather than the right-side slide-over
// StoryDetailPanel (Write Stories) still uses — this is Review's own
// panel and the only one restructured here; Write Stories' slide-over,
// and the EditableStoryContent/AcceptanceCriteriaTable/StoryDescription
// pieces it's built from, are untouched. Section order below now follows
// real JIRA's own field order (header → acceptance criteria → description
// → JIRA metadata → attachments → comment) rather than
// EditableStoryContent's fixed internal order (type toggle → description
// → acceptance criteria → save), so this panel composes
// StoryDescription/AcceptanceCriteriaTable/DivisionItemAttachmentsSection
// directly instead of going through that shared wrapper — the "Generated"
// badge + type-toggle row EditableStoryContent also renders is
// reproduced inline here (small, ~10 lines) rather than shared, since
// splitting it out into its own component for one reused fragment would
// cost more complexity than it saves.

// The Epic field's SearchableSelect onSearch — a thin wrapper over GET
// /epics/search, mapping its {key, name} response into
// {value, label} the same way the old eager epics-fetch's options={} did
// (label = "SRVPS-80 — Public Prosecution"). Module-level since it needs
// nothing from ReviewStoryPanel's own props/state.
async function searchEpics(query: string): Promise<SearchableSelectOption[]> {
  const response = await apiClient.get<RunEpic[]>('/epics/search', { params: { q: query } })
  return response.data.map((epic) => ({ value: epic.key, label: `${epic.key} — ${epic.name}` }))
}

// Roles tab fields' SearchableSelect onSearch — same thin-wrapper shape as
// searchEpics. searchUsers takes fieldId since GET /users/search does (see
// its own docstring for why); value is the bare username so it round-trips
// straight into the publish payload unchanged.
async function searchUsers(fieldId: string, query: string): Promise<SearchableSelectOption[]> {
  const response = await apiClient.get<{ name: string; displayName: string }[]>('/users/search', {
    params: { field_id: fieldId, q: query },
  })
  return response.data.map((user) => ({ value: user.name, label: `${user.displayName} (${user.name})` }))
}

async function searchGroups(query: string): Promise<SearchableSelectOption[]> {
  const response = await apiClient.get<{ name: string }[]>('/groups/search', { params: { q: query } })
  return response.data.map((group) => ({ value: group.name, label: group.name }))
}

function ReviewStoryPanel({
  runId,
  item,
  story,
  isGenerating,
  cardError,
  onGenerate,
  onRunUpdated,
  projects,
  isLoadingProjects,
  fields,
  onFieldsChange,
  onClose,
}: ReviewStoryPanelProps) {
  const acKeyCounterRef = useRef(0)

  function makeAcRow(text: string): AcRow {
    acKeyCounterRef.current += 1
    return { key: acKeyCounterRef.current, text }
  }

  const [localDescription, setLocalDescription] = useState(story.description)
  const [localAcceptanceCriteria, setLocalAcceptanceCriteria] = useState<AcRow[]>(() =>
    story.acceptance_criteria.map(makeAcRow),
  )
  const [localStoryType, setLocalStoryType] = useState<'Business' | 'Technical'>(story.story_type)
  // Free-text notes below the AC table — see requirement: JIRA's real
  // acceptance-criteria field is one text blob under the hood, so this is
  // purely an editing-time convenience alongside the per-row table, not a
  // separate persisted concept. It has no baseline to resync from (the
  // backend has nowhere to store "notes" distinct from "criteria rows")
  // and no independent save path: on Save Changes it's appended as one
  // more entry onto the acceptance_criteria array actually sent to the
  // server (see handleSaveChanges), then cleared — after that, if it had
  // content, it simply shows up as its own row in the table next time,
  // same as everything else in that array. Resets for free on every
  // Regenerate/new-item mount since ReviewView keys this component by
  // item.id.
  const [localNotes, setLocalNotes] = useState('')
  // Draft copy of the JIRA metadata fields — initialized from the `fields`
  // prop (RunPage's committed publishFieldsByStoryId entry) once, on
  // mount, same as every other local* field here. Editing epic/priority/
  // story points/sprint/comment updates ONLY this local copy; nothing
  // reaches RunPage (and therefore nothing survives closing this panel
  // without saving) until handleSaveChanges pushes it via onFieldsChange.
  const [draftFields, setDraftFields] = useState<PublishFields>(fields)
  // Which of the JIRA METADATA section's two tabs is showing — purely a
  // display toggle, not itself part of draftFields/PublishFields (nothing
  // here is a story field, it doesn't affect what gets saved/published).
  const [metadataTab, setMetadataTab] = useState<'fields' | 'roles'>('fields')

  function updateDraftFields(patch: Partial<PublishFields>) {
    setDraftFields((current) => ({ ...current, ...patch }))
  }

  // Accounts and field availability both depend on which project is
  // selected, so both refetch on draftFields.projectId change — unlike
  // Epic (instance-wide search, no project scoping at all) and unlike the
  // Project list itself (fetched once, in ReviewView). A project change
  // clears accountId/functionalArea/each Roles-tab value already chosen:
  // those are only ever valid for the project they were picked under (an
  // account linked to TRKDJP isn't a valid customfield_10002 value for
  // TNOQRL, and a field hidden by the new project's availability
  // shouldn't silently keep a stale value that can no longer be edited).
  const [accounts, setAccounts] = useState<RunAccount[]>([])
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(true)
  const [accountsError, setAccountsError] = useState<string | null>(null)
  const [fieldAvailability, setFieldAvailability] = useState<PublishFieldAvailability | null>(null)
  const [isLoadingAvailability, setIsLoadingAvailability] = useState(true)
  const [availabilityError, setAvailabilityError] = useState<string | null>(null)
  const isFirstProjectLoadRef = useRef(true)

  useEffect(() => {
    const projectKey = projects.find((project) => project.id === draftFields.projectId)?.key
    if (!projectKey) return

    // Skip clearing on the very first run (mount) — draftFields was
    // seeded from the story's own committed fields, which are still
    // valid for its already-selected project; only an actual PO-driven
    // project change should reset the rest.
    if (!isFirstProjectLoadRef.current) {
      updateDraftFields({
        accountId: '',
        functionalArea: [],
        roleProductManager: '',
        roleProductOwner: '',
        roleDeliveryManager: '',
        roleServiceManager: '',
        roleSoftwareEngineer: '',
        roleQualityEngineer: '',
        roleAssignedGroup: '',
        roleOwner: '',
      })
    }
    isFirstProjectLoadRef.current = false

    let cancelled = false

    setIsLoadingAccounts(true)
    setAccountsError(null)
    apiClient
      .get<RunAccount[]>('/accounts', {
        params: { project_id: draftFields.projectId },
        headers: NO_CACHE_REQUEST_HEADERS,
      })
      .then((response) => {
        if (cancelled) return
        setAccounts(response.data)
        const defaultAccount =
          response.data.find((account) => account.name === DEFAULT_ACCOUNT_NAME) ?? response.data[0]
        if (defaultAccount) updateDraftFields({ accountId: defaultAccount.id.toString() })
      })
      .catch((err) => {
        if (!cancelled) setAccountsError(extractErrorMessage(err, 'Failed to load accounts.'))
      })
      .finally(() => {
        if (!cancelled) setIsLoadingAccounts(false)
      })

    const selectedProjectName = projects.find((project) => project.id === draftFields.projectId)?.name

    setIsLoadingAvailability(true)
    setAvailabilityError(null)
    apiClient
      .get<PublishFieldAvailability>(`/projects/${projectKey}/publish-fields`, {
        headers: NO_CACHE_REQUEST_HEADERS,
      })
      .then((response) => {
        if (cancelled) return
        setFieldAvailability(response.data)
        // Best-effort default, same spirit as Account's DEFAULT_ACCOUNT_NAME
        // match: if one of this project's Functional Area options is named
        // exactly after the project itself (true for TRKDJP -> "Dubai
        // Justice Platform"; not guaranteed for every project — TNOQRL's
        // options are "Noqodi-Mobile"/"Noqodi-Web" etc, not a bare
        // "Noqodi" — hence "if one exists", not always), preselect it
        // rather than leaving the PO to find it themselves. Never
        // overrides an already-made selection (checked via the functional
        // update form, not the possibly-stale `draftFields` closure).
        const defaultOption = response.data.functional_area_options?.find(
          (option) => option.value.toLowerCase() === selectedProjectName?.toLowerCase(),
        )
        if (defaultOption) {
          setDraftFields((current) =>
            current.functionalArea.length === 0
              ? { ...current, functionalArea: [defaultOption.id] }
              : current,
          )
        }
      })
      .catch((err) => {
        if (!cancelled) setAvailabilityError(extractErrorMessage(err, 'Failed to check this project’s fields.'))
      })
      .finally(() => {
        if (!cancelled) setIsLoadingAvailability(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only on an actual project change; `projects` itself doesn't change after ReviewView's one-time fetch
  }, [draftFields.projectId])

  function isFieldAvailable(availabilityKey: string): boolean {
    // Fail OPEN only while the check hasn't resolved yet (still loading,
    // or the request itself failed) — hiding every field just because the
    // availability check hasn't finished would be worse than occasionally
    // showing one JIRA ends up rejecting; the per-project check is a
    // courtesy in that case, not the only line of defense (JIRA's own 400
    // is still the backstop either way, same as before this feature
    // existed). Once it HAS resolved and says this project isn't usable
    // at all (no Story-equivalent issue type, or no create access), fail
    // CLOSED instead — showing fields for a project that's already been
    // confirmed can't take them would be the "silently broken form" this
    // whole check exists to avoid; see the "not usable" banner below,
    // which is what should be visible in that case instead of any fields.
    if (!fieldAvailability) return true
    if (!fieldAvailability.usable) return false
    return fieldAvailability.fields[availabilityKey] ?? true
  }

  const projectOptions = projects.map((project) => ({
    value: project.id,
    label: `${project.key} — ${project.name}`,
  }))

  // Two distinct "this project can't take any of the known fields"
  // states, both meaning the Fields/Roles tabs have nothing useful to
  // show: no Story-equivalent issue type (or no create access) at all
  // (fieldAvailability.usable === false — SRVSLM, every service-desk
  // project checked, PNREV), or a Story-equivalent DOES exist but none of
  // the 14 known fields are actually on its screen (usable === true, all
  // false — not observed yet on any project checked, but not ruled out
  // either, hence still handled explicitly rather than assumed away).
  const publishFieldsUnsupported =
    !!fieldAvailability && fieldAvailability.usable && !Object.values(fieldAvailability.fields).some(Boolean)
  const showPublishFieldsForm = !fieldAvailability || (fieldAvailability.usable && !publishFieldsUnsupported)

  // The "last known persisted" baseline — hasChanges compares local
  // against THIS, not against the story prop directly, same reasoning as
  // StoryDetailPanel's identical fields.
  const [savedDescription, setSavedDescription] = useState(story.description)
  const [savedAcceptanceCriteria, setSavedAcceptanceCriteria] = useState<string[]>(
    story.acceptance_criteria,
  )
  const [savedStoryType, setSavedStoryType] = useState<'Business' | 'Technical'>(story.story_type)

  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveJustSucceeded, flashSaveSucceeded] = useSavedFlash()

  const [isConfirmingRegenerate, setIsConfirmingRegenerate] = useState(false)

  // Resync local editable state whenever the server-side story content
  // changes for a reason OTHER than our own last save — i.e. Regenerate
  // replaced it (same story id, new content). Same reasoning as
  // StoryDetailPanel's identical effect (story here is never undefined,
  // unlike there, since ReviewView only ever mounts this panel for an
  // item that already has one).
  useEffect(() => {
    const acChanged =
      JSON.stringify(story.acceptance_criteria) !== JSON.stringify(savedAcceptanceCriteria)
    if (story.description !== savedDescription || story.story_type !== savedStoryType || acChanged) {
      setLocalDescription(story.description)
      setLocalAcceptanceCriteria(story.acceptance_criteria.map(makeAcRow))
      setLocalStoryType(story.story_type)
      setSavedDescription(story.description)
      setSavedAcceptanceCriteria(story.acceptance_criteria)
      setSavedStoryType(story.story_type)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story.description, story.acceptance_criteria, story.story_type])

  function updateAcceptanceCriterion(key: number, text: string) {
    setLocalAcceptanceCriteria((rows) => rows.map((row) => (row.key === key ? { ...row, text } : row)))
  }

  function deleteAcceptanceCriterion(key: number) {
    setLocalAcceptanceCriteria((rows) => rows.filter((row) => row.key !== key))
  }

  function addAcceptanceCriterion() {
    setLocalAcceptanceCriteria((rows) => [...rows, makeAcRow('')])
  }

  const localAcTexts = localAcceptanceCriteria.map((row) => row.text)
  const trimmedNotes = localNotes.trim()
  const hasChanges =
    localDescription !== savedDescription ||
    localStoryType !== savedStoryType ||
    trimmedNotes !== '' ||
    JSON.stringify(localAcTexts) !== JSON.stringify(savedAcceptanceCriteria) ||
    JSON.stringify(draftFields) !== JSON.stringify(fields)

  async function handleSaveChanges() {
    if (!hasChanges) return
    setIsSaving(true)
    setSaveError(null)
    // Table rows first, formatted as before, then the free-text notes (if
    // any) appended as one final entry — matches the requirement to
    // concatenate rows-then-notes into the single field the backend (and
    // eventually JIRA) actually stores.
    const acceptanceCriteriaToSave = trimmedNotes ? [...localAcTexts, trimmedNotes] : localAcTexts
    try {
      const response = await apiClient.put<Run>(`/runs/${runId}/stories/${story.id}`, {
        description: localDescription,
        acceptance_criteria: acceptanceCriteriaToSave,
        story_type: localStoryType,
      })
      onRunUpdated(response.data)
      // Only pushed to RunPage's committed publishFieldsByStoryId once the
      // description/AC/type PUT above has actually succeeded — a failed
      // save shouldn't half-commit the JIRA fields while leaving the rest
      // of this attempt failed and retryable.
      onFieldsChange(draftFields)
      setLocalNotes('')
      flashSaveSucceeded()
    } catch (err) {
      setSaveError(extractErrorMessage(err, 'Failed to save story changes.'))
    } finally {
      setIsSaving(false)
    }
  }

  // Same [NEEDS CLARIFICATION]-in-AC flag as StoryDetailPanel/RowStatusBadge.
  const isFlagged = localAcTexts.some((ac) => ac.startsWith('[NEEDS CLARIFICATION]'))

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`themed-scroll flex max-h-[90vh] w-full max-w-4xl flex-col overflow-y-auto rounded-xl border bg-abyss shadow-2xl shadow-black/50 ${
          isFlagged ? 'border-amber/40' : 'border-white/15'
        }`}
      >
        {/* HEADER — ID badge, title, story type, Regenerate, Close. Was
            buried at the bottom of the old EditableStoryContent-driven
            layout ("Generated" badge + type toggle sat below Description/
            AC); now it's the first thing in the modal, matching real
            JIRA's own issue-view layout. Sticky so it stays visible while
            the body below scrolls in a long story. */}
        <div className="sticky top-0 z-10 flex shrink-0 items-start justify-between gap-3 border-b border-white/10 bg-abyss/95 px-6 py-5 backdrop-blur-md">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-block rounded-full border border-indigo/30 bg-glass px-2 py-0.5 font-mono text-xs text-indigo">
                {item.id}
              </span>
              <div className="inline-flex rounded-full border border-white/10 bg-void/30 p-0.5">
                {(['Business', 'Technical'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setLocalStoryType(type)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      localStoryType === type ? 'bg-indigo text-white' : 'text-white/50 hover:text-white'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>
            <h2 className="mt-2 font-display text-lg font-semibold text-white">
              {item.title || '(untitled)'}
            </h2>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isConfirmingRegenerate ? (
              <div className="flex items-center gap-2 rounded-md border border-amber/30 bg-amber/10 px-3 py-1.5 text-xs text-amber">
                <span className="whitespace-nowrap">This will replace the current story.</span>
                <button
                  type="button"
                  onClick={() => {
                    setIsConfirmingRegenerate(false)
                    onGenerate()
                  }}
                  className="font-medium underline decoration-dotted hover:text-white"
                >
                  Regenerate
                </button>
                <button
                  type="button"
                  onClick={() => setIsConfirmingRegenerate(false)}
                  className="text-white/50 hover:text-white"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsConfirmingRegenerate(true)}
                disabled={isGenerating}
                className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-white/15 px-3 py-1.5 text-xs font-medium text-white/60 transition-colors hover:border-indigo/40 hover:text-indigo disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshIcon className={`h-3.5 w-3.5 ${isGenerating ? 'animate-spin' : ''}`} />
                Regenerate
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-lg text-white/40 transition-colors hover:bg-white/10 hover:text-white"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex-1 px-6 py-5">
          {cardError && <p className="mb-4 text-sm text-red-400">{cardError}</p>}

          {/* ACCEPTANCE CRITERIA — before Description now, matching real
              JIRA's own field order. */}
          <AcceptanceCriteriaTable
            rows={localAcceptanceCriteria}
            onUpdate={updateAcceptanceCriterion}
            onDelete={deleteAcceptanceCriterion}
            onAdd={addAcceptanceCriterion}
          />
          <div className="mt-2">
            <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
              Additional Notes <span className="normal-case text-white/30">(optional)</span>
            </label>
            <AutoGrowTextarea
              value={localNotes}
              onChange={(event) => setLocalNotes(event.target.value)}
              rows={2}
              placeholder="Anything that doesn't fit as its own row above — folded into the same field on save"
              className="mt-1 w-full rounded-md border border-white/10 bg-void/40 p-2 text-sm text-white/90 outline-none placeholder:text-white/25 focus:border-indigo focus:ring-1 focus:ring-indigo"
            />
          </div>

          {/* DESCRIPTION */}
          <div className="mt-6 border-t border-white/10 pt-5">
            <StoryDescription value={localDescription} onChange={setLocalDescription} />
          </div>

          {/* JIRA METADATA */}
          <div className="mt-6 border-t border-white/10 pt-5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-white/50">
              JIRA Publish Fields
            </h3>
            <p className="mt-1 text-xs text-white/40">
              Held locally — nothing is sent to JIRA until you publish this story.
            </p>

            {isLoadingAvailability && (
              <p className="mt-2 text-xs text-white/40">Checking this project's fields…</p>
            )}
            {availabilityError && <p className="mt-2 text-sm text-red-400">{availabilityError}</p>}
            {fieldAvailability && !fieldAvailability.usable && (
              <p className="mt-2 text-sm text-clay">{fieldAvailability.error}</p>
            )}
            {publishFieldsUnsupported && (
              <p className="mt-2 text-sm text-clay">
                This project doesn't use the standard story fields — publishing may not be supported
                here yet.
              </p>
            )}
            {accountsError && <p className="mt-2 text-sm text-red-400">{accountsError}</p>}

            <div className="mt-3">
              <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                Project <span className="text-clay">*</span>
              </label>
              <div className="mt-1">
                <SearchableSelect
                  mode="static"
                  value={draftFields.projectId}
                  onChange={(projectId) => updateDraftFields({ projectId })}
                  isLoading={isLoadingProjects}
                  placeholder="Search projects by key or name…"
                  options={projectOptions}
                />
              </div>
            </div>

            {showPublishFieldsForm && (
              <>
                <div className="mt-6 mb-5 flex justify-center">
                  <div className="inline-flex gap-1 rounded-full border border-white/15 bg-void/40 p-1">
                    {(
                      [
                        { id: 'fields', label: 'Fields' },
                        { id: 'roles', label: 'Roles' },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setMetadataTab(tab.id)}
                        className={`rounded-full px-6 py-2 text-sm font-semibold transition-colors ${
                          metadataTab === tab.id
                            ? 'bg-indigo text-white shadow-sm'
                            : 'text-white/60 hover:text-white'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>

                {metadataTab === 'fields' && (
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {isFieldAvailable('epic_link') && (
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                      Epic <span className="text-clay">*</span>
                    </label>
                    <div className="mt-1">
                      <SearchableSelect
                        mode="search"
                        value={draftFields.epicKey}
                        onChange={(epicKey) => updateDraftFields({ epicKey })}
                        onSearch={searchEpics}
                        placeholder="Search epics by key or name…"
                      />
                    </div>
                  </div>
                )}

                {isFieldAvailable('account') && (
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                      Account <span className="text-clay">*</span>
                    </label>
                    <div className="relative mt-1">
                      <select
                        value={draftFields.accountId}
                        onChange={(event) => updateDraftFields({ accountId: event.target.value })}
                        disabled={isLoadingAccounts}
                        className="block w-full appearance-none rounded-md border border-white/10 bg-void/40 py-2 pl-2 pr-8 text-sm text-white/90 outline-none focus:border-indigo focus:ring-1 focus:ring-indigo disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <option value="">
                          {isLoadingAccounts ? 'Loading accounts…' : '— Select an account —'}
                        </option>
                        {accounts.map((account) => (
                          <option key={account.id} value={account.id.toString()}>
                            {account.name} ({account.key})
                          </option>
                        ))}
                      </select>
                      <ChevronIcon className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
                    </div>
                  </div>
                )}

                {isFieldAvailable('functional_area') && (
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                      Functional Area <span className="text-clay">*</span>
                    </label>
                    <div className="mt-1">
                      <MultiSearchableSelect
                        values={draftFields.functionalArea}
                        onChange={(functionalArea) => updateDraftFields({ functionalArea })}
                        placeholder="Search functional areas…"
                        options={(fieldAvailability?.functional_area_options ?? []).map((option) => ({
                          value: option.id,
                          label: option.value,
                        }))}
                      />
                    </div>
                  </div>
                )}

                {isFieldAvailable('priority') && (
                  <div>
                    <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                      Priority
                    </label>
                    <div className="relative mt-1">
                      <select
                        value={draftFields.priority}
                        onChange={(event) => updateDraftFields({ priority: event.target.value })}
                        className="block w-full appearance-none rounded-md border border-white/10 bg-void/40 py-2 pl-2 pr-8 text-sm text-white/90 outline-none focus:border-indigo focus:ring-1 focus:ring-indigo"
                      >
                        <option value="">— None —</option>
                        {JIRA_PRIORITY_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                      <ChevronIcon className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
                    </div>
                  </div>
                )}

                {isFieldAvailable('story_points') && (
                  <div>
                    <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                      Story Points
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={draftFields.storyPoints}
                      onChange={(event) => updateDraftFields({ storyPoints: event.target.value })}
                      placeholder="—"
                      className="mt-1 block w-full rounded-md border border-white/10 bg-void/40 p-2 text-sm text-white/90 outline-none placeholder:text-white/25 focus:border-indigo focus:ring-1 focus:ring-indigo"
                    />
                  </div>
                )}

                {isFieldAvailable('sprint') && (
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                      Sprint
                    </label>
                    <input
                      type="text"
                      value={draftFields.sprint}
                      onChange={(event) => updateDraftFields({ sprint: event.target.value })}
                      placeholder="Freeform for now — no sprint-fetch endpoint yet"
                      className="mt-1 block w-full rounded-md border border-white/10 bg-void/40 p-2 text-sm text-white/90 outline-none placeholder:text-white/25 focus:border-indigo focus:ring-1 focus:ring-indigo"
                    />
                  </div>
                )}
              </div>
            )}

            {metadataTab === 'roles' && (
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {ROLE_FIELDS.filter((role) => isFieldAvailable(role.availabilityKey)).map((role) => (
                  <div key={role.key}>
                    <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                      {role.label} {role.required && <span className="text-clay">*</span>}
                    </label>
                    <div className="mt-1">
                      <SearchableSelect
                        mode="search"
                        value={draftFields[role.key]}
                        onChange={(value) => updateDraftFields({ [role.key]: value } as Partial<PublishFields>)}
                        onSearch={(query) =>
                          role.kind === 'user' ? searchUsers(role.fieldId, query) : searchGroups(query)
                        }
                        placeholder={`Search ${role.label.toLowerCase()}…`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
              </>
            )}
          </div>

          {/* ATTACHMENTS */}
          <div className="mt-6 border-t border-white/10 pt-5">
            <DivisionItemAttachmentsSection
              runId={runId}
              item={item}
              onRunUpdated={onRunUpdated}
              variant="jira"
            />
          </div>

          {/* COMMENT */}
          <div className="mt-6 border-t border-white/10 pt-5">
            <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
              Comment
            </label>
            <AutoGrowTextarea
              value={draftFields.comment}
              onChange={(event) => updateDraftFields({ comment: event.target.value })}
              rows={2}
              placeholder="Optional — added as a JIRA comment on publish"
              className="mt-1 w-full rounded-md border border-white/10 bg-void/40 p-2 text-sm text-white/90 outline-none placeholder:text-white/25 focus:border-indigo focus:ring-1 focus:ring-indigo"
            />
          </div>
        </div>

        {/* Sticky footer — Save Changes. Not a real per-story Publish
            (confirmed): actual JIRA writes stay a bulk action on the
            separate Publish step. */}
        <div className="sticky bottom-0 z-10 flex shrink-0 items-center justify-end gap-2 border-t border-white/10 bg-abyss/95 px-6 py-4 backdrop-blur-md">
          {saveError && <p className="mr-auto text-sm text-red-400">{saveError}</p>}
          {saveJustSucceeded && <span className="text-xs text-teal">Saved</span>}
          <button
            type="button"
            onClick={handleSaveChanges}
            disabled={!hasChanges || isSaving}
            className="rounded-md border border-white/10 bg-glass px-4 py-2 text-sm text-white/80 transition-colors hover:border-indigo/40 hover:text-indigo disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSaving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface BulkEditPanelProps {
  runId: string
  projects: RunProject[]
  isLoadingProjects: boolean
  includedEntries: ReviewableEntry[]
  onUpdatePublishFields: (storyId: string, patch: Partial<PublishFields>) => void
  onRunUpdated: (run: Run) => void
  onClose: () => void
}

// Bulk counterpart to ReviewStoryPanel's JIRA Publish Fields section — same
// Fields/Roles tabs, same field set, same project-driven accounts/
// availability fetch, but applied across every currently-included story at
// once instead of one story's already-committed fields.
//
// Starts from EMPTY_PUBLISH_FIELDS (no single story to seed from) and
// tracks which fields the PO actually touched in touchedFields, separately
// from bulkFields' values. On Apply, only touched fields go into the patch
// sent to onUpdatePublishFields for every included story — untouched
// fields are left alone rather than overwritten with blanks. Touch is
// tracked explicitly rather than inferred from "value differs from
// EMPTY_PUBLISH_FIELDS" on purpose: Project's own default (DEFAULT_PROJECT_ID)
// is a real, selectable value, not a stand-in for "untouched" — a PO who
// deliberately picks the default project for every included story needs
// that to still count as touched, which a value-diff heuristic would miss.
//
// Attachments aren't part of PublishFields (that's per-division-item,
// upload-now, via DivisionItemAttachmentsSection elsewhere) — bulk mode
// stages files locally instead and uploads them to every included
// division item only on Apply, since there's no single item to upload to
// before the included set is known. Comment IS a PublishFields field
// already, so it rides the same touched-field patch as everything else —
// no separate delivery path needed.
function BulkEditPanel({
  runId,
  projects,
  isLoadingProjects,
  includedEntries,
  onUpdatePublishFields,
  onRunUpdated,
  onClose,
}: BulkEditPanelProps) {
  const [bulkFields, setBulkFields] = useState<PublishFields>(EMPTY_PUBLISH_FIELDS)
  const [touchedFields, setTouchedFields] = useState<Set<keyof PublishFields>>(new Set())

  function updateBulkFields(patch: Partial<PublishFields>) {
    setBulkFields((current) => ({ ...current, ...patch }))
    setTouchedFields((current) => {
      const next = new Set(current)
      for (const key of Object.keys(patch)) next.add(key as keyof PublishFields)
      return next
    })
  }

  const [metadataTab, setMetadataTab] = useState<'fields' | 'roles'>('fields')

  const [accounts, setAccounts] = useState<RunAccount[]>([])
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(true)
  const [accountsError, setAccountsError] = useState<string | null>(null)
  const [fieldAvailability, setFieldAvailability] = useState<PublishFieldAvailability | null>(null)
  const [isLoadingAvailability, setIsLoadingAvailability] = useState(true)
  const [availabilityError, setAvailabilityError] = useState<string | null>(null)
  const isFirstProjectLoadRef = useRef(true)

  // Same project-keyed accounts/availability fetch as ReviewStoryPanel's
  // identical effect, adapted to also drop touched-ness (not just value)
  // from the fields it clears on an actual project change — an account
  // picked for the old project is meaningless for the new one, and
  // shouldn't silently apply as "clear this on every included story"
  // either.
  useEffect(() => {
    const projectKey = projects.find((project) => project.id === bulkFields.projectId)?.key
    if (!projectKey) return

    if (!isFirstProjectLoadRef.current) {
      setBulkFields((current) => ({
        ...current,
        accountId: '',
        functionalArea: [],
        roleProductManager: '',
        roleProductOwner: '',
        roleDeliveryManager: '',
        roleServiceManager: '',
        roleSoftwareEngineer: '',
        roleQualityEngineer: '',
        roleAssignedGroup: '',
        roleOwner: '',
      }))
      setTouchedFields((current) => {
        const next = new Set(current)
        ;(
          [
            'accountId',
            'functionalArea',
            'roleProductManager',
            'roleProductOwner',
            'roleDeliveryManager',
            'roleServiceManager',
            'roleSoftwareEngineer',
            'roleQualityEngineer',
            'roleAssignedGroup',
            'roleOwner',
          ] as const
        ).forEach((key) => next.delete(key))
        return next
      })
    }
    isFirstProjectLoadRef.current = false

    let cancelled = false

    setIsLoadingAccounts(true)
    setAccountsError(null)
    apiClient
      .get<RunAccount[]>('/accounts', {
        params: { project_id: bulkFields.projectId },
        headers: NO_CACHE_REQUEST_HEADERS,
      })
      .then((response) => {
        if (!cancelled) setAccounts(response.data)
      })
      .catch((err) => {
        if (!cancelled) setAccountsError(extractErrorMessage(err, 'Failed to load accounts.'))
      })
      .finally(() => {
        if (!cancelled) setIsLoadingAccounts(false)
      })

    setIsLoadingAvailability(true)
    setAvailabilityError(null)
    apiClient
      .get<PublishFieldAvailability>(`/projects/${projectKey}/publish-fields`, {
        headers: NO_CACHE_REQUEST_HEADERS,
      })
      .then((response) => {
        if (!cancelled) setFieldAvailability(response.data)
      })
      .catch((err) => {
        if (!cancelled) setAvailabilityError(extractErrorMessage(err, "Failed to check this project's fields."))
      })
      .finally(() => {
        if (!cancelled) setIsLoadingAvailability(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only on an actual project change; `projects` doesn't change after ReviewView's one-time fetch
  }, [bulkFields.projectId])

  function isFieldAvailable(availabilityKey: string): boolean {
    if (!fieldAvailability) return true
    if (!fieldAvailability.usable) return false
    return fieldAvailability.fields[availabilityKey] ?? true
  }

  const publishFieldsUnsupported =
    !!fieldAvailability && fieldAvailability.usable && !Object.values(fieldAvailability.fields).some(Boolean)
  const showPublishFieldsForm = !fieldAvailability || (fieldAvailability.usable && !publishFieldsUnsupported)

  const projectOptions = projects.map((project) => ({
    value: project.id,
    label: `${project.key} — ${project.name}`,
  }))

  const [stagedFiles, setStagedFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  function addStagedFiles(files: File[]) {
    if (files.length === 0) return
    setStagedFiles((current) => [...current, ...files])
  }

  function removeStagedFile(index: number) {
    setStagedFiles((current) => current.filter((_, i) => i !== index))
  }

  const [isApplying, setIsApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [appliedMessage, flashApplied] = useMessageFlash(3000)

  const hasAnythingToApply = touchedFields.size > 0 || stagedFiles.length > 0

  async function handleApply() {
    if (!hasAnythingToApply || includedEntries.length === 0) return
    setIsApplying(true)
    setApplyError(null)
    try {
      if (touchedFields.size > 0) {
        const patch: Partial<PublishFields> = {}
        for (const key of touchedFields) {
          ;(patch as Record<string, unknown>)[key] = bulkFields[key]
        }
        for (const entry of includedEntries) {
          onUpdatePublishFields(entry.story.id, patch)
        }
      }

      // Sequential, not Promise.all — each response is the run's full
      // state AFTER that one upload, so resolving out of order would let
      // an earlier (slower) response's stale extra_attachments clobber a
      // later one's in onRunUpdated.
      if (stagedFiles.length > 0) {
        for (const entry of includedEntries) {
          const formData = new FormData()
          for (const file of stagedFiles) formData.append('files', file)
          const response = await apiClient.post<Run>(
            `/runs/${runId}/division/${entry.item.id}/attachments`,
            formData,
            { headers: { 'Content-Type': 'multipart/form-data' } },
          )
          onRunUpdated(response.data)
        }
        setStagedFiles([])
      }

      flashApplied(
        `Applied to ${includedEntries.length} ${includedEntries.length === 1 ? 'story' : 'stories'}`,
      )
      setTouchedFields(new Set())
    } catch (err) {
      setApplyError(extractErrorMessage(err, 'Failed to apply bulk changes.'))
    } finally {
      setIsApplying(false)
    }
  }

  function touchedBadge(key: keyof PublishFields) {
    return touchedFields.has(key) ? (
      <span className="ml-1.5 text-[10px] font-normal normal-case text-teal">will apply</span>
    ) : null
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="themed-scroll flex max-h-[90vh] w-full max-w-4xl flex-col overflow-y-auto rounded-xl border border-indigo/30 bg-abyss shadow-2xl shadow-black/50"
      >
        <div className="sticky top-0 z-10 flex shrink-0 items-start justify-between gap-3 border-b border-white/10 bg-abyss/95 px-6 py-5 backdrop-blur-md">
          <div className="min-w-0 flex-1">
            <span className="inline-block rounded-full border border-indigo/30 bg-glass px-2 py-0.5 font-mono text-xs text-indigo">
              Bulk Edit
            </span>
            <h2 className="mt-2 font-display text-lg font-semibold text-white">
              {includedEntries.length} {includedEntries.length === 1 ? 'story' : 'stories'} included
            </h2>
            <p className="mt-1 text-xs text-white/40">
              Only fields you change below are applied — anything left untouched is skipped on every
              included story, not cleared.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-lg text-white/40 transition-colors hover:bg-white/10 hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="flex-1 px-6 py-5">
          {isLoadingAvailability && (
            <p className="mt-2 text-xs text-white/40">Checking this project's fields…</p>
          )}
          {availabilityError && <p className="mt-2 text-sm text-red-400">{availabilityError}</p>}
          {fieldAvailability && !fieldAvailability.usable && (
            <p className="mt-2 text-sm text-clay">{fieldAvailability.error}</p>
          )}
          {publishFieldsUnsupported && (
            <p className="mt-2 text-sm text-clay">
              This project doesn't use the standard story fields — publishing may not be supported
              here yet.
            </p>
          )}
          {accountsError && <p className="mt-2 text-sm text-red-400">{accountsError}</p>}

          <div className="mt-3">
            <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
              Project {touchedBadge('projectId')}
            </label>
            <div className="mt-1">
              <SearchableSelect
                mode="static"
                value={bulkFields.projectId}
                onChange={(projectId) => updateBulkFields({ projectId })}
                isLoading={isLoadingProjects}
                placeholder="Search projects by key or name…"
                options={projectOptions}
              />
            </div>
          </div>

          {showPublishFieldsForm && (
            <>
              <div className="mt-6 mb-5 flex justify-center">
                <div className="inline-flex gap-1 rounded-full border border-white/15 bg-void/40 p-1">
                  {(
                    [
                      { id: 'fields', label: 'Fields' },
                      { id: 'roles', label: 'Roles' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setMetadataTab(tab.id)}
                      className={`rounded-full px-6 py-2 text-sm font-semibold transition-colors ${
                        metadataTab === tab.id
                          ? 'bg-indigo text-white shadow-sm'
                          : 'text-white/60 hover:text-white'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              {metadataTab === 'fields' && (
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {isFieldAvailable('epic_link') && (
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                        Epic {touchedBadge('epicKey')}
                      </label>
                      <div className="mt-1">
                        <SearchableSelect
                          mode="search"
                          value={bulkFields.epicKey}
                          onChange={(epicKey) => updateBulkFields({ epicKey })}
                          onSearch={searchEpics}
                          placeholder="Search epics by key or name…"
                        />
                      </div>
                    </div>
                  )}

                  {isFieldAvailable('account') && (
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                        Account {touchedBadge('accountId')}
                      </label>
                      <div className="relative mt-1">
                        <select
                          value={bulkFields.accountId}
                          onChange={(event) => updateBulkFields({ accountId: event.target.value })}
                          disabled={isLoadingAccounts}
                          className="block w-full appearance-none rounded-md border border-white/10 bg-void/40 py-2 pl-2 pr-8 text-sm text-white/90 outline-none focus:border-indigo focus:ring-1 focus:ring-indigo disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <option value="">
                            {isLoadingAccounts ? 'Loading accounts…' : '— Select an account —'}
                          </option>
                          {accounts.map((account) => (
                            <option key={account.id} value={account.id.toString()}>
                              {account.name} ({account.key})
                            </option>
                          ))}
                        </select>
                        <ChevronIcon className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
                      </div>
                    </div>
                  )}

                  {isFieldAvailable('functional_area') && (
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                        Functional Area {touchedBadge('functionalArea')}
                      </label>
                      <div className="mt-1">
                        <MultiSearchableSelect
                          values={bulkFields.functionalArea}
                          onChange={(functionalArea) => updateBulkFields({ functionalArea })}
                          placeholder="Search functional areas…"
                          options={(fieldAvailability?.functional_area_options ?? []).map((option) => ({
                            value: option.id,
                            label: option.value,
                          }))}
                        />
                      </div>
                    </div>
                  )}

                  {isFieldAvailable('priority') && (
                    <div>
                      <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                        Priority {touchedBadge('priority')}
                      </label>
                      <div className="relative mt-1">
                        <select
                          value={bulkFields.priority}
                          onChange={(event) => updateBulkFields({ priority: event.target.value })}
                          className="block w-full appearance-none rounded-md border border-white/10 bg-void/40 py-2 pl-2 pr-8 text-sm text-white/90 outline-none focus:border-indigo focus:ring-1 focus:ring-indigo"
                        >
                          <option value="">— None —</option>
                          {JIRA_PRIORITY_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                        <ChevronIcon className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
                      </div>
                    </div>
                  )}

                  {isFieldAvailable('story_points') && (
                    <div>
                      <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                        Story Points {touchedBadge('storyPoints')}
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        value={bulkFields.storyPoints}
                        onChange={(event) => updateBulkFields({ storyPoints: event.target.value })}
                        placeholder="—"
                        className="mt-1 block w-full rounded-md border border-white/10 bg-void/40 p-2 text-sm text-white/90 outline-none placeholder:text-white/25 focus:border-indigo focus:ring-1 focus:ring-indigo"
                      />
                    </div>
                  )}

                  {isFieldAvailable('sprint') && (
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                        Sprint {touchedBadge('sprint')}
                      </label>
                      <input
                        type="text"
                        value={bulkFields.sprint}
                        onChange={(event) => updateBulkFields({ sprint: event.target.value })}
                        placeholder="Freeform for now — no sprint-fetch endpoint yet"
                        className="mt-1 block w-full rounded-md border border-white/10 bg-void/40 p-2 text-sm text-white/90 outline-none placeholder:text-white/25 focus:border-indigo focus:ring-1 focus:ring-indigo"
                      />
                    </div>
                  )}
                </div>
              )}

              {metadataTab === 'roles' && (
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {ROLE_FIELDS.filter((role) => isFieldAvailable(role.availabilityKey)).map((role) => (
                    <div key={role.key}>
                      <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                        {role.label} {role.required && <span className="text-clay">*</span>}{' '}
                        {touchedBadge(role.key)}
                      </label>
                      <div className="mt-1">
                        <SearchableSelect
                          mode="search"
                          value={bulkFields[role.key] as string}
                          onChange={(value) =>
                            updateBulkFields({ [role.key]: value } as Partial<PublishFields>)
                          }
                          onSearch={(query) =>
                            role.kind === 'user' ? searchUsers(role.fieldId, query) : searchGroups(query)
                          }
                          placeholder={`Search ${role.label.toLowerCase()}…`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ATTACHMENTS — staged locally, uploaded to every included
              division item only on Apply (unlike ReviewStoryPanel's
              DivisionItemAttachmentsSection, which is upload-now against
              one item — there's no single item here to upload to until
              Apply resolves the whole included set). */}
          <div className="mt-6 border-t border-white/10 pt-5">
            <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
              Attachments
            </label>
            <p className="mt-1 text-xs text-white/40">
              Attached to every included story's ticket when published.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPTED_EXTENSIONS}
              className="hidden"
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? [])
                event.target.value = ''
                addStagedFiles(picked)
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="mt-2 rounded-md border border-dashed border-white/15 px-3 py-1.5 text-xs font-medium text-white/60 transition-colors hover:border-indigo/40 hover:text-indigo"
            >
              + Attach files
            </button>
            {stagedFiles.length > 0 && (
              <ul className="mt-2 space-y-1">
                {stagedFiles.map((file, index) => (
                  <li
                    key={`${file.name}-${index}`}
                    className="flex items-center justify-between gap-2 rounded-md border border-white/10 bg-void/30 px-2 py-1 text-xs text-white/70"
                  >
                    <span className="truncate">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => removeStagedFile(index)}
                      aria-label={`Remove ${file.name}`}
                      className="shrink-0 text-white/40 hover:text-white"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* COMMENT */}
          <div className="mt-6 border-t border-white/10 pt-5">
            <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
              Comment {touchedBadge('comment')}
            </label>
            <AutoGrowTextarea
              value={bulkFields.comment}
              onChange={(event) => updateBulkFields({ comment: event.target.value })}
              rows={2}
              placeholder="Optional — added as a JIRA comment on publish, on every included story"
              className="mt-1 w-full rounded-md border border-white/10 bg-void/40 p-2 text-sm text-white/90 outline-none placeholder:text-white/25 focus:border-indigo focus:ring-1 focus:ring-indigo"
            />
          </div>
        </div>

        <div className="sticky bottom-0 z-10 flex shrink-0 items-center justify-end gap-2 border-t border-white/10 bg-abyss/95 px-6 py-4 backdrop-blur-md">
          {applyError && <p className="mr-auto text-sm text-red-400">{applyError}</p>}
          {appliedMessage && <span className="mr-auto text-xs text-teal">{appliedMessage}</span>}
          <button
            type="button"
            onClick={handleApply}
            disabled={!hasAnythingToApply || isApplying || includedEntries.length === 0}
            className="rounded-md bg-indigo px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo/30 transition-shadow hover:shadow-indigo/50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isApplying
              ? 'Applying…'
              : `Apply to ${includedEntries.length} ${includedEntries.length === 1 ? 'story' : 'stories'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

interface RowStatusBadgeProps {
  isGenerating: boolean
  isGenerated: boolean
  isFlagged: boolean
}

function RowStatusBadge({ isGenerating, isGenerated, isFlagged }: RowStatusBadgeProps) {
  if (isGenerating) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo/30 bg-indigo/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-indigo">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo" />
        Generating
      </span>
    )
  }
  if (!isGenerated) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-white/40">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-500/40" />
        Not Generated
      </span>
    )
  }
  if (isFlagged) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber/30 bg-amber/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-amber">
        <span className="h-1.5 w-1.5 rounded-full bg-amber" />
        Needs Clarification
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-teal/30 bg-teal/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-teal">
      <ThinCheckIcon className="h-3 w-3" />
      Generated
    </span>
  )
}

// One row's publish outcome for the current batch run. 'idle' before
// "Publish Selected" has touched it (or if it was never included);
// 'published' carries an optional jiraUrl since a story that was already
// published in an earlier session only has its jira_key (see PublishView's
// getDisplayStatus) — same "plain text if we don't have a real URL"
// fallback the old per-story panel used.
type RowPublishStatus =
  | { kind: 'idle' }
  | { kind: 'publishing' }
  | { kind: 'published'; jiraKey: string; jiraUrl?: string }
  | { kind: 'failed'; message: string }

function PublishBatchRowStatus({ status }: { status: RowPublishStatus }) {
  switch (status.kind) {
    case 'idle':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-white/40">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-500/40" />
          Not Published
        </span>
      )
    case 'publishing':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo/30 bg-indigo/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-indigo">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo" />
          Publishing…
        </span>
      )
    case 'published':
      return (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-teal/30 bg-teal/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-teal">
            <ThinCheckIcon className="h-3 w-3" />
            Published
          </span>
          {status.jiraUrl ? (
            <a
              href={status.jiraUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="font-mono text-xs text-indigo underline decoration-dotted hover:text-indigo/80"
            >
              {status.jiraKey}
            </a>
          ) : (
            <span className="font-mono text-xs text-white/50">{status.jiraKey}</span>
          )}
        </div>
      )
    case 'failed':
      return (
        <div className="flex flex-col gap-0.5">
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-clay/40 bg-clay/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-clay">
            <span className="h-1.5 w-1.5 rounded-full bg-clay" />
            Failed
          </span>
          <span className="text-xs text-red-400">{status.message}</span>
        </div>
      )
  }
}

interface PublishStoryResponse {
  jira_key: string
  jira_url: string
  attachments_uploaded: number
  comment_added: boolean
}

interface PublishViewProps {
  run: Run
  onRunUpdated: (run: Run) => void
  includedStoryIds: Set<string>
  publishFieldsByStoryId: Record<string, PublishFields>
  onBackToReview: () => void
}

// The Publish step: only the stories checked "include" back in Review, one
// "Publish Selected" button that walks them one at a time (same
// one-at-a-time, isolate-failures shape as ApprovedDivisionList's Generate
// All) calling the existing POST /stories/{id}/publish with each story's
// fields from Review's publishFieldsByStoryId. No per-row panel here —
// everything editable already happened in Review; this step only acts.
function PublishView({ run, onRunUpdated, includedStoryIds, publishFieldsByStoryId, onBackToReview }: PublishViewProps) {
  const [rowStatuses, setRowStatuses] = useState<Record<string, RowPublishStatus>>({})
  const [isPublishingBatch, setIsPublishingBatch] = useState(false)
  const [hasRunBatch, setHasRunBatch] = useState(false)

  const includedEntries: ReviewableEntry[] = run.story_division
    .map((item) => ({ item, story: findGeneratedStory(run, item.id) }))
    .filter(
      (entry): entry is ReviewableEntry => !!entry.story && includedStoryIds.has(entry.story.id),
    )

  // story.jira_key is the durable record (persisted on the run); a live
  // in-progress/failed/just-published status for THIS batch run always
  // wins over it while present.
  function getDisplayStatus(story: UserStory): RowPublishStatus {
    const live = rowStatuses[story.id]
    if (live) return live
    if (story.jira_key) return { kind: 'published', jiraKey: story.jira_key }
    return { kind: 'idle' }
  }

  async function handlePublishSelected() {
    if (includedEntries.length === 0 || isPublishingBatch) return
    setIsPublishingBatch(true)
    setHasRunBatch(true)
    try {
      for (const { story } of includedEntries) {
        // Never re-publish an already-created issue — a retry after a
        // partial failure should only touch the ones that actually
        // failed, not create a duplicate JIRA issue for one that already
        // succeeded (this run or an earlier one).
        if (getDisplayStatus(story).kind === 'published') continue

        const fields = publishFieldsByStoryId[story.id]
        // The 4 empirically-confirmed-required fields (see
        // REQUIRED_STRING_FIELDS_TAB_KEYS) — checked unconditionally
        // rather than against per-project field availability (that lives
        // in ReviewStoryPanel's own local state, not lifted up here):
        // every project confirmed usable this far (Story issue type
        // present) has had all 4 present too, every time checked
        // (TRKDJP/TNOQRL/TRKDN) — a project missing Story entirely is
        // already blocked earlier, in ReviewStoryPanel itself.
        const missingStringField = !fields
          ? 'Project'
          : REQUIRED_STRING_FIELDS_TAB_KEYS.find((key) => fields[key].trim() === '')
        const missing = missingStringField
          ? missingStringField === 'epicKey'
            ? 'Epic'
            : missingStringField === 'accountId'
              ? 'Account'
              : missingStringField
          : fields && fields.functionalArea.length === 0
            ? 'Functional Area'
            : fields && fields.roleProductOwner.trim() === ''
              ? 'Product Owner'
              : null
        if (missing) {
          // Client-side check before even calling the API — matches
          // JIRA's real required-field behavior, same as the required
          // markers in ReviewStoryPanel.
          setRowStatuses((statuses) => ({
            ...statuses,
            [story.id]: { kind: 'failed', message: `Failed — no ${missing} selected` },
          }))
          continue
        }

        setRowStatuses((statuses) => ({ ...statuses, [story.id]: { kind: 'publishing' } }))
        try {
          const response = await apiClient.post<PublishStoryResponse>(
            `/runs/${run.run_id}/stories/${story.id}/publish`,
            {
              project_id: fields.projectId,
              epic_key: fields.epicKey,
              account_id: fields.accountId,
              product_owner: fields.roleProductOwner,
              priority: fields.priority || null,
              story_points: fields.storyPoints.trim() === '' ? null : Number(fields.storyPoints),
              comment: fields.comment.trim() === '' ? null : fields.comment,
              functional_area: fields.functionalArea.length === 0 ? null : fields.functionalArea,
              product_manager: fields.roleProductManager.trim() === '' ? null : fields.roleProductManager,
              delivery_manager: fields.roleDeliveryManager.trim() === '' ? null : fields.roleDeliveryManager,
              service_manager: fields.roleServiceManager.trim() === '' ? null : fields.roleServiceManager,
              software_engineer:
                fields.roleSoftwareEngineer.trim() === '' ? null : fields.roleSoftwareEngineer,
              quality_engineer: fields.roleQualityEngineer.trim() === '' ? null : fields.roleQualityEngineer,
              assigned_group: fields.roleAssignedGroup.trim() === '' ? null : fields.roleAssignedGroup,
              owner: fields.roleOwner.trim() === '' ? null : fields.roleOwner,
            },
          )
          setRowStatuses((statuses) => ({
            ...statuses,
            [story.id]: {
              kind: 'published',
              jiraKey: response.data.jira_key,
              jiraUrl: response.data.jira_url,
            },
          }))
        } catch (err) {
          setRowStatuses((statuses) => ({
            ...statuses,
            [story.id]: { kind: 'failed', message: extractErrorMessage(err, 'Failed to publish to JIRA.') },
          }))
        }
      }

      // /publish returns its own small response shape per call, not a
      // full PipelineState — one refetch at the end of the whole batch
      // (rather than one per story) is enough to persist story.jira_key
      // into run state, since rowStatuses above already covers "updates
      // live as each call completes" on its own.
      const runResponse = await apiClient.get<Run>(`/runs/${run.run_id}`)
      onRunUpdated(runResponse.data)
    } finally {
      setIsPublishingBatch(false)
    }
  }

  const publishedCount = includedEntries.filter(
    ({ story }) => getDisplayStatus(story).kind === 'published',
  ).length
  const failedCount = includedEntries.filter(
    ({ story }) => getDisplayStatus(story).kind === 'failed',
  ).length

  return (
    <div className="flex max-w-7xl flex-col gap-6">
      <div className="border-b border-white/10 pb-6">
        <PhaseBreadcrumb status={run.status} approvedPhase="publish" />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-indigo/40 bg-glass shadow-[0_0_16px_rgba(124,111,242,0.25)]">
              <EditIcon className="h-5 w-5 text-indigo" />
            </div>
            <div>
              <h1 className="bg-gradient-to-r from-indigo to-teal bg-clip-text font-display text-2xl font-semibold text-transparent">
                Publish to JIRA
              </h1>
              <p className="mt-1 font-mono text-sm text-white/50">{includedEntries.length} selected</p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={onBackToReview}
              disabled={isPublishingBatch}
              className="rounded-md border border-white/10 px-4 py-3 text-sm text-white/60 transition-colors hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={handlePublishSelected}
              disabled={includedEntries.length === 0 || isPublishingBatch}
              className="shrink-0 rounded-md bg-indigo px-6 py-3 text-sm font-medium text-white shadow-lg shadow-indigo/30 transition-shadow hover:shadow-indigo/50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isPublishingBatch ? (
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
                  Publishing…
                </span>
              ) : (
                `Publish Selected (${includedEntries.length})`
              )}
            </button>
          </div>
        </div>
      </div>

      {hasRunBatch && !isPublishingBatch && (
        <div className="rounded-lg border border-teal/30 bg-teal/10 px-4 py-2.5 text-sm text-teal">
          {publishedCount} published, {failedCount} failed.
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-white/15 bg-glass backdrop-blur-md">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 font-mono text-[10px] uppercase tracking-wide text-white/40">
              <th className="px-4 py-3 font-medium">ID</th>
              <th className="px-4 py-3 font-medium">Title</th>
              <th className="px-4 py-3 font-medium">Epic</th>
              <th className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {includedEntries.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-sm text-white/40">
                  Nothing selected — go back to Review and check at least one story.
                </td>
              </tr>
            )}
            {includedEntries.map(({ item, story }) => (
              <tr key={item.id} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3 font-mono text-xs text-indigo">{item.id}</td>
                <td className="px-4 py-3 text-white/90">{item.title || '(untitled)'}</td>
                <td className="px-4 py-3 font-mono text-xs text-white/60">
                  {publishFieldsByStoryId[story.id]?.epicKey || '— none —'}
                </td>
                <td className="px-4 py-3">
                  <PublishBatchRowStatus status={getDisplayStatus(story)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

interface ParsedDescriptionParagraph {
  /** The matched lead phrase exactly as it appears in the text (whatever
   *  case Claude/the PO actually wrote — "As a", "As an", "I want", "So
   *  that" — not a canonicalized version), rendered in <strong>. */
  lead: string
  /** Everything else on that line, trimmed and stripped of a leading/
   *  trailing comma left over from the original "As a X, I want Y, so
   *  that Z" comma-joined sentence. */
  rest: string
}

interface ParsedDescription {
  leadParagraphs: [ParsedDescriptionParagraph, ParsedDescriptionParagraph, ParsedDescriptionParagraph]
  /** Anything after the "So that ..." clause's own sentence (split on the
   *  first blank line following it) — the "plus any relevant context"
   *  the story-detail prompt adds after the core As-a/I-want/So-that
   *  sentence. Rendered as its own plain paragraph(s) below the three
   *  bolded lines, not discarded and not forced into the "So that" line. */
  extraParagraphs: string[]
}

// Mirrors how real JIRA renders the house "As a X, I want Y, so that Z"
// story format: three short lines, each with its lead phrase bolded. Pure
// string parsing, no change to how description is actually stored — a
// description that doesn't contain all three phrases in order (older
// stories, hand-written text, anything else) returns null so the caller
// falls back to one plain paragraph, unmodified.
function parseUserStoryDescription(description: string): ParsedDescription | null {
  const asMatch = description.match(/\bAs an?\b/i)
  if (!asMatch || asMatch.index === undefined) return null
  const asStart = asMatch.index

  const wantMatch = description.slice(asStart).match(/\bI want\b/i)
  if (!wantMatch || wantMatch.index === undefined) return null
  const wantStart = asStart + wantMatch.index

  const soThatMatch = description.slice(wantStart).match(/\bso that\b/i)
  if (!soThatMatch || soThatMatch.index === undefined) return null
  const soThatStart = wantStart + soThatMatch.index

  const trimClause = (text: string) => text.trim().replace(/^,\s*/, '').replace(/,\s*$/, '')

  const asText = trimClause(description.slice(asStart + asMatch[0].length, wantStart))
  const wantText = trimClause(description.slice(wantStart + wantMatch[0].length, soThatStart))

  const afterSoThat = description.slice(soThatStart + soThatMatch[0].length)
  const blankLineMatch = afterSoThat.match(/\n[ \t]*\n/)
  const soThatEnd =
    blankLineMatch && blankLineMatch.index !== undefined
      ? soThatStart + soThatMatch[0].length + blankLineMatch.index
      : description.length
  const soThatText = trimClause(description.slice(soThatStart + soThatMatch[0].length, soThatEnd))

  // A conforming match needs real content on all three lines — an empty
  // clause (e.g. "so that" appearing with nothing meaningful after it,
  // some degenerate edit) isn't worth rendering as a bolded stub line.
  if (!asText || !wantText || !soThatText) return null

  const extra = description.slice(soThatEnd).trim()
  const extraParagraphs = extra
    ? extra
        .split(/\n[ \t]*\n/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
    : []

  return {
    leadParagraphs: [
      { lead: asMatch[0], rest: asText },
      { lead: wantMatch[0], rest: wantText },
      { lead: soThatMatch[0], rest: soThatText },
    ],
    extraParagraphs,
  }
}

interface StoryDescriptionProps {
  value: string
  onChange: (value: string) => void
}

// Click-to-edit description field, shared by StoryDetailPanel and
// ReviewStoryPanel. Read view renders the JIRA-style bolded-lead-phrase
// paragraphs from parseUserStoryDescription when the text matches that
// shape; otherwise (and while editing) it's the plain single-paragraph
// view this always used to be. The "Show more"/clamp affordance only
// applies to that plain fallback — the structured rendering is already
// broken into short lines and, like real JIRA, is shown in full rather
// than clamped.
//
// Deliberately no "Saved" flash on blur here (there used to be one) —
// this field is never independently persisted; it's local state gated
// entirely behind the panel's own Save Changes button (see
// StoryDetailPanel/ReviewStoryPanel's handleSaveChanges). A flash saying
// "Saved" the moment you click away from the textarea was actively
// misleading — it implied a persist that hadn't happened, which is
// exactly the "changes appear to save automatically" bug this was part
// of. Exiting edit mode on blur is still correct (nothing to fix there);
// only the false confirmation is gone.
function StoryDescription({ value, onChange }: StoryDescriptionProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [isOverflowing, setIsOverflowing] = useState(false)
  const previewRef = useRef<HTMLParagraphElement>(null)

  const parsed = value ? parseUserStoryDescription(value) : null

  useEffect(() => {
    if (parsed || isEditing || isExpanded) return
    function checkOverflow() {
      const el = previewRef.current
      if (!el) return
      setIsOverflowing(el.scrollHeight > el.clientHeight + 1)
    }
    checkOverflow()

    let resizeTimeout: ReturnType<typeof setTimeout>
    function handleResize() {
      clearTimeout(resizeTimeout)
      resizeTimeout = setTimeout(checkOverflow, 150)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      clearTimeout(resizeTimeout)
      window.removeEventListener('resize', handleResize)
    }
  }, [value, parsed, isEditing, isExpanded])

  return (
    <div>
      <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
        Description
      </label>
      {isEditing ? (
        <AutoGrowTextarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => setIsEditing(false)}
          autoFocus
          className="-mx-1 mt-1 w-full rounded border-b border-dashed border-indigo bg-transparent px-1 text-sm leading-relaxed text-slate-300 outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setIsEditing(true)}
          className="-mx-1 mt-1 block w-full cursor-text rounded px-1 py-0.5 text-left transition-colors hover:bg-white/5"
        >
          {!value ? (
            <p className="text-sm leading-relaxed text-slate-300">
              <span className="text-white/30">Description — click to add</span>
            </p>
          ) : parsed ? (
            <div className="flex flex-col gap-1.5 text-sm leading-relaxed text-slate-300">
              {parsed.leadParagraphs.map(({ lead, rest }, index) => (
                <p key={index}>
                  <strong className="font-semibold text-white">{lead}</strong> {rest}
                </p>
              ))}
              {parsed.extraParagraphs.map((paragraph, index) => (
                <p key={`extra-${index}`} className="whitespace-pre-wrap text-slate-300/90">
                  {paragraph}
                </p>
              ))}
            </div>
          ) : (
            <p
              ref={previewRef}
              className={`whitespace-pre-wrap text-sm leading-relaxed text-slate-300 ${
                isExpanded ? '' : 'line-clamp-2'
              }`}
            >
              {value}
            </p>
          )}
        </button>
      )}
      {!parsed && isOverflowing && (
        <div className="mt-1 flex items-center gap-3">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              setIsExpanded((expanded) => !expanded)
            }}
            className="text-xs font-medium text-indigo transition-colors hover:text-indigo/80"
          >
            {isExpanded ? 'Show less' : 'Show more'}
          </button>
        </div>
      )}
    </div>
  )
}

interface AcceptanceCriterionCellProps {
  value: string
  onChange: (value: string) => void
}

// Just the click-to-edit text — same pattern every other click-to-edit
// field in this file uses. Its own component (not inlined in the table's
// .map()) so isEditing is per-row local state, same rules-of-hooks
// reasoning as DivisionItemCard.
function AcceptanceCriterionCell({ value, onChange }: AcceptanceCriterionCellProps) {
  const [isEditing, setIsEditing] = useState(false)

  return isEditing ? (
    <AutoGrowTextarea
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={() => setIsEditing(false)}
      autoFocus
      rows={1}
      className="w-full rounded border-b border-dashed border-indigo bg-transparent text-sm text-slate-300 outline-none"
    />
  ) : (
    <button
      type="button"
      onClick={() => setIsEditing(true)}
      className="-mx-1 block w-full cursor-text rounded px-1 py-0.5 text-left text-sm text-slate-300 transition-colors hover:bg-white/5"
    >
      {value || <span className="text-white/30">Empty criterion — click to edit</span>}
    </button>
  )
}

interface AcceptanceCriteriaTableProps {
  rows: AcRow[]
  onUpdate: (key: number, text: string) => void
  onDelete: (key: number) => void
  onAdd: () => void
}

// Two-column ID/text table mimicking JIRA's own acceptance-criteria
// rendering (AC-01, AC-02, … — sequential, derived from array position at
// render time, never stored) — replaces the old bullet-list-with-a-
// floating-× layout. [NEEDS CLARIFICATION] rows get the same amber tint
// the rest of the app already uses for that flag, applied to the whole
// row (background + left border), not just the ID badge, so it reads at a
// glance while scanning the table rather than only on close inspection.
function AcceptanceCriteriaTable({ rows, onUpdate, onDelete, onAdd }: AcceptanceCriteriaTableProps) {
  return (
    <div>
      <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
        Acceptance Criteria
      </label>
      <div className="mt-1 overflow-hidden rounded-lg border border-white/10">
        <table className="w-full table-fixed text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5 font-mono text-[10px] uppercase tracking-wide text-white/40">
              <th className="w-16 px-3 py-2 font-medium">ID</th>
              <th className="px-3 py-2 font-medium">Acceptance Criteria</th>
              <th className="w-7 px-1 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-3 text-center text-xs text-white/30">
                  No acceptance criteria yet.
                </td>
              </tr>
            )}
            {rows.map((row, index) => {
              const isFlagged = row.text.startsWith('[NEEDS CLARIFICATION]')
              return (
                <tr
                  key={row.key}
                  className={`border-b border-white/5 last:border-0 ${
                    isFlagged ? 'border-l-2 border-l-amber bg-amber/10' : ''
                  }`}
                >
                  <td
                    className={`px-3 py-2 align-top font-mono text-xs ${
                      isFlagged ? 'text-amber' : 'text-indigo'
                    }`}
                  >
                    AC-{String(index + 1).padStart(2, '0')}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <AcceptanceCriterionCell value={row.text} onChange={(text) => onUpdate(row.key, text)} />
                  </td>
                  <td className="px-1 py-2 align-top text-right">
                    <button
                      type="button"
                      onClick={() => onDelete(row.key)}
                      aria-label="Delete criterion"
                      className="px-1 text-white/30 transition-colors hover:text-clay"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="mt-1.5 rounded-md border border-white/10 bg-glass px-3 py-1 text-xs text-white/70 transition-colors hover:border-indigo/40 hover:text-indigo"
      >
        + Add Criterion
      </button>
    </div>
  )
}

interface EditableStoryContentProps {
  storyType: 'Business' | 'Technical'
  onStoryTypeChange: (type: 'Business' | 'Technical') => void
  description: string
  onDescriptionChange: (value: string) => void
  acceptanceCriteria: AcRow[]
  onUpdateCriterion: (key: number, text: string) => void
  onDeleteCriterion: (key: number) => void
  onAddCriterion: () => void
  hasChanges: boolean
  isSaving: boolean
  saveError: string | null
  saveJustSucceeded: boolean
  onSaveChanges: () => void
  /** Rendered between the acceptance-criteria table and the Save Changes
   *  row — StoryDetailPanel puts its attachments section there, matching
   *  where it always sat relative to Save Changes; ReviewStoryPanel has
   *  its own separate attachments spot further down (amid the JIRA
   *  fields) and passes nothing here. */
  children?: ReactNode
}

// The "generated story" editing block — type toggle, description,
// acceptance criteria, Save Changes — shared by StoryDetailPanel (Write
// Stories) and ReviewStoryPanel (Review) rather than duplicated between
// them like it used to be. All the state this needs (local vs saved
// baseline, resync-on-regenerate, the save call itself) still lives in
// whichever panel renders this, since that's genuinely different between
// the two (StoryDetailPanel also has title/summary editing alongside it,
// ReviewStoryPanel has the JIRA publish fields below it); this component
// only owns the presentation.
function EditableStoryContent({
  storyType,
  onStoryTypeChange,
  description,
  onDescriptionChange,
  acceptanceCriteria,
  onUpdateCriterion,
  onDeleteCriterion,
  onAddCriterion,
  hasChanges,
  isSaving,
  saveError,
  saveJustSucceeded,
  onSaveChanges,
  children,
}: EditableStoryContentProps) {
  return (
    <div className="mt-4 border-t border-white/10 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-teal/30 bg-teal/10 px-2.5 py-1">
          <ThinCheckIcon className="h-3 w-3 text-teal" />
          <span className="font-mono text-xs text-teal">Generated</span>
        </span>

        <div className="inline-flex rounded-full border border-white/10 bg-void/30 p-0.5">
          {(['Business', 'Technical'] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => onStoryTypeChange(type)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                storyType === type ? 'bg-indigo text-white' : 'text-white/50 hover:text-white'
              }`}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <StoryDescription value={description} onChange={onDescriptionChange} />
      </div>

      <div className="mt-4">
        <AcceptanceCriteriaTable
          rows={acceptanceCriteria}
          onUpdate={onUpdateCriterion}
          onDelete={onDeleteCriterion}
          onAdd={onAddCriterion}
        />
      </div>

      {children}

      {saveError && <p className="mt-3 text-sm text-red-400">{saveError}</p>}

      <div className="mt-4 flex items-center justify-end gap-2">
        {saveJustSucceeded && <span className="text-xs text-teal">Saved</span>}
        <button
          type="button"
          onClick={onSaveChanges}
          disabled={!hasChanges || isSaving}
          className="rounded-md border border-white/10 bg-glass px-4 py-2 text-sm text-white/80 transition-colors hover:border-indigo/40 hover:text-indigo disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isSaving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}

interface DivisionItemAttachmentsSectionProps {
  runId: string
  item: StoryDivisionItem
  onRunUpdated: (run: Run) => void
  /** 'default' (Write Stories' StoryDetailPanel, unchanged): a plain row
   *  list, label/note about regeneration context. 'jira' (Review's
   *  centered modal): dashed drag-and-drop zone, a thumbnail/icon grid,
   *  and copy that's explicit these files go to the actual JIRA ticket.
   *  Same upload plumbing either way — this only changes presentation. */
  variant?: 'default' | 'jira'
}

// Extracted out of StoryDetailPanel (where this originated) so
// ReviewStoryPanel can reuse the exact same upload plumbing rather than
// duplicating it — both panels hit the same POST
// /division/{division_item_id}/attachments endpoint and just want the
// resulting item.extra_attachments reflected once it lands.
function DivisionItemAttachmentsSection({
  runId,
  item,
  onRunUpdated,
  variant = 'default',
}: DivisionItemAttachmentsSectionProps) {
  const [isAttaching, setIsAttaching] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  // Set, not a single id: nothing stops the PO clicking × on two different
  // files in quick succession, and each removal is its own independent
  // request — same reasoning as ApprovedDivisionList's generatingIds.
  const [removingFilenames, setRemovingFilenames] = useState<Set<string>>(new Set())
  const attachInputRef = useRef<HTMLInputElement>(null)

  // Attachments upload/remove immediately against the server — unlike
  // description/AC/type/the JIRA metadata fields above them (which are
  // buffered as local drafts and only committed on Save Changes), there's
  // no local-only "staged" state to defer here; the existing endpoints
  // are upload-now/delete-now by design. So this doesn't feed the panel's
  // hasChanges/dirty tracking at all — instead each successful
  // attach/remove gets its own brief inline confirmation (this flash),
  // independent of the Save Changes button, so it's still clear the
  // action actually completed.
  const [confirmationMessage, flashConfirmation] = useMessageFlash()

  function openAttachPicker() {
    attachInputRef.current?.click()
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return
    setIsAttaching(true)
    setAttachError(null)
    const formData = new FormData()
    for (const file of files) {
      formData.append('files', file)
    }
    try {
      const response = await apiClient.post<Run>(
        `/runs/${runId}/division/${item.id}/attachments`,
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      )
      onRunUpdated(response.data)
      flashConfirmation(files.length === 1 ? 'Attached' : `Attached ${files.length} files`)
    } catch (err) {
      setAttachError(extractErrorMessage(err, 'Failed to upload attachment.'))
    } finally {
      setIsAttaching(false)
    }
  }

  // filename, not the full absolute path — matches what DELETE
  // /division/{id}/attachments/{filename} (routes.py) actually matches
  // against, since extra_attachments stores server-side absolute paths
  // the frontend has no other reason to know.
  async function removeFile(filename: string) {
    setRemovingFilenames((names) => new Set(names).add(filename))
    setAttachError(null)
    try {
      const response = await apiClient.delete<Run>(
        `/runs/${runId}/division/${item.id}/attachments/${encodeURIComponent(filename)}`,
      )
      onRunUpdated(response.data)
      flashConfirmation('Removed')
    } catch (err) {
      setAttachError(extractErrorMessage(err, 'Failed to remove attachment.'))
    } finally {
      setRemovingFilenames((names) => {
        const next = new Set(names)
        next.delete(filename)
        return next
      })
    }
  }

  function handleAttachFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    // Same live-FileList-must-be-copied-before-the-input-resets caveat as
    // HomePage's handleFilesPicked.
    const picked = Array.from(event.target.files ?? [])
    event.target.value = ''
    uploadFiles(picked)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDragOver(false)
    uploadFiles(Array.from(event.dataTransfer.files))
  }

  if (variant === 'jira') {
    return (
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
            Attachments
          </label>
          {/* Independent of Save Changes/hasChanges on purpose — see the
              confirmationMessage comment above. Fades on its own; doesn't
              wait for (or get cleared by) a Save Changes click. */}
          {confirmationMessage && <span className="text-xs text-teal">{confirmationMessage}</span>}
        </div>
        <p className="mt-1 text-xs text-white/40">
          These files will be attached to the JIRA ticket when published.
        </p>
        <p className="mt-0.5 text-xs text-white/30">Attachments save immediately.</p>

        {item.extra_attachments.length > 0 && (
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {item.extra_attachments.map((path) => {
              const filename = getFileNameFromPath(path)
              const isRemoving = removingFilenames.has(filename)
              return (
                <div
                  key={path}
                  className="group relative flex flex-col items-center gap-1.5 rounded-lg border border-white/10 bg-void/30 p-2.5 text-center"
                >
                  <button
                    type="button"
                    onClick={() => removeFile(filename)}
                    disabled={isRemoving}
                    title={isRemoving ? 'Removing…' : `Remove ${filename}`}
                    aria-label={`Remove ${filename}`}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-white/15 bg-abyss text-xs text-white/60 transition-colors hover:border-clay/50 hover:text-clay disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isRemoving ? (
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-clay" />
                    ) : (
                      '×'
                    )}
                  </button>
                  <FileTypeBadge filename={filename} />
                  <span className="w-full truncate text-[11px] text-white/70" title={filename}>
                    {filename}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        <div
          role="button"
          tabIndex={0}
          onClick={openAttachPicker}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openAttachPicker()
            }
          }}
          onDragOver={(event) => {
            event.preventDefault()
            setIsDragOver(true)
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          className={`mt-2 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-3 py-5 text-center transition-colors ${
            isDragOver ? 'border-indigo bg-indigo/10' : 'border-white/15 bg-void/20 hover:border-indigo/40'
          }`}
        >
          {isAttaching ? (
            <span className="flex items-center gap-2 text-xs text-white/50">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo" />
              Uploading…
            </span>
          ) : (
            <span className="text-xs text-white/50">Drop files to attach, or browse</span>
          )}
        </div>
        <input
          ref={attachInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPTED_EXTENSIONS}
          onChange={handleAttachFilesPicked}
          className="hidden"
        />
        {attachError && <p className="mt-1 text-xs text-red-400">{attachError}</p>}
      </div>
    )
  }

  return (
    <div>
      <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
        Attach More Files
      </label>
      <p className="mt-1 text-xs text-white/40">
        Included automatically alongside the original source files next time you regenerate.
      </p>

      {item.extra_attachments.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {item.extra_attachments.map((path) => (
            <div
              key={path}
              className="flex items-center gap-2 rounded-md border border-white/10 bg-void/30 px-2.5 py-1.5"
            >
              <FileTypeBadge filename={getFileNameFromPath(path)} />
              <span className="min-w-0 flex-1 truncate text-sm text-white/80">
                {getFileNameFromPath(path)}
              </span>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={openAttachPicker}
        disabled={isAttaching}
        className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-white/15 bg-void/20 px-3 py-2 text-xs text-white/50 transition-colors hover:border-indigo/40 hover:text-indigo disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isAttaching ? (
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo" />
            Uploading…
          </span>
        ) : (
          '+ Attach files'
        )}
      </button>
      <input
        ref={attachInputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPTED_EXTENSIONS}
        onChange={handleAttachFilesPicked}
        className="hidden"
      />
      {attachError && <p className="mt-1 text-xs text-red-400">{attachError}</p>}
    </div>
  )
}

interface AcRow {
  key: number
  text: string
}

interface StoryDetailPanelProps {
  item: StoryDivisionItem
  story: UserStory | undefined
  isGenerating: boolean
  cardError: string | undefined
  runId: string
  onGenerate: () => void
  onRunUpdated: (run: Run) => void
  /** Persists a title/summary edit via the parent's PUT /division call —
   *  see handleSaveDivisionItem in ApprovedDivisionList for why that
   *  (rather than a new endpoint) is what this hits. */
  onSaveDivisionItem: (patch: Partial<StoryDivisionItem>) => Promise<void>
  onClose: () => void
}

// Slide-over panel opened from a table row's "View"/"Generate" click —
// replaces the old permanent two-column (nav + always-open card) layout,
// so viewing/editing a single story no longer costs permanent screen
// space; the table is the primary view and this is a temporary overlay on
// top of it.
//
// Handles both states a division item can be in here: no story yet (just
// the Generate button, as before) and a generated story to review/edit.
// All the editing hooks below are called unconditionally regardless of
// which state we're in — conditionally skipping them based on `story`
// would violate the rules of hooks — with story?.field ?? fallback
// defaults; the editing JSX itself just doesn't render when there's no
// story yet, so the unused state in that case is harmless.
function StoryDetailPanel({
  item,
  story,
  isGenerating,
  cardError,
  runId,
  onGenerate,
  onRunUpdated,
  onSaveDivisionItem,
  onClose,
}: StoryDetailPanelProps) {
  const acKeyCounterRef = useRef(0)

  function makeAcRow(text: string): AcRow {
    acKeyCounterRef.current += 1
    return { key: acKeyCounterRef.current, text }
  }

  const [localDescription, setLocalDescription] = useState(story?.description ?? '')
  const [localAcceptanceCriteria, setLocalAcceptanceCriteria] = useState<AcRow[]>(() =>
    (story?.acceptance_criteria ?? []).map(makeAcRow),
  )
  const [localStoryType, setLocalStoryType] = useState<'Business' | 'Technical'>(
    story?.story_type ?? 'Business',
  )
  // The "last known persisted" baseline — hasChanges compares local
  // against THIS, not against the story prop directly, so an in-flight
  // edit is never accidentally treated as clean just because the parent
  // re-rendered for an unrelated reason (e.g. another card generating).
  const [savedDescription, setSavedDescription] = useState(story?.description ?? '')
  const [savedAcceptanceCriteria, setSavedAcceptanceCriteria] = useState<string[]>(
    story?.acceptance_criteria ?? [],
  )
  const [savedStoryType, setSavedStoryType] = useState<'Business' | 'Technical'>(
    story?.story_type ?? 'Business',
  )

  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveJustSucceeded, flashSaveSucceeded] = useSavedFlash()

  // Title/summary edit here targets the division item itself (via
  // onSaveDivisionItem), not the generated story — relevant both before
  // and after generation, since the PO might want to tighten up the
  // division item's own text even after a story already exists for it.
  const [localTitle, setLocalTitle] = useState(item.title)
  const [localSummary, setLocalSummary] = useState(item.summary)
  const [isTitleEditing, setIsTitleEditing] = useState(false)
  const [isSummaryEditing, setIsSummaryEditing] = useState(false)
  const [titleJustSaved, flashTitleSaved] = useSavedFlash()
  const [summaryJustSaved, flashSummarySaved] = useSavedFlash()
  const [divisionSaveError, setDivisionSaveError] = useState<string | null>(null)
  const [isConfirmingRegenerate, setIsConfirmingRegenerate] = useState(false)

  const titleInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isTitleEditing) return
    const el = titleInputRef.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [isTitleEditing])

  async function commitTitleEdit() {
    setIsTitleEditing(false)
    if (localTitle === item.title) return
    setDivisionSaveError(null)
    try {
      await onSaveDivisionItem({ title: localTitle })
      flashTitleSaved()
    } catch (err) {
      setDivisionSaveError(extractErrorMessage(err, 'Failed to save title.'))
    }
  }

  async function commitSummaryEdit() {
    setIsSummaryEditing(false)
    if (localSummary === item.summary) return
    setDivisionSaveError(null)
    try {
      await onSaveDivisionItem({ summary: localSummary })
      flashSummarySaved()
    } catch (err) {
      setDivisionSaveError(extractErrorMessage(err, 'Failed to save summary.'))
    }
  }

  // Resync local editable state whenever the server-side story content
  // changes for a reason OTHER than our own last save — i.e. Regenerate
  // replaced it (same story id, new content), or this is the first time a
  // story showed up for this card. Comparing against the *saved* baseline
  // rather than local state is what keeps this from clobbering an
  // in-progress edit the PO hasn't saved yet.
  useEffect(() => {
    if (!story) return
    const acChanged =
      JSON.stringify(story.acceptance_criteria) !== JSON.stringify(savedAcceptanceCriteria)
    if (
      story.description !== savedDescription ||
      story.story_type !== savedStoryType ||
      acChanged
    ) {
      setLocalDescription(story.description)
      setLocalAcceptanceCriteria(story.acceptance_criteria.map(makeAcRow))
      setLocalStoryType(story.story_type)
      setSavedDescription(story.description)
      setSavedAcceptanceCriteria(story.acceptance_criteria)
      setSavedStoryType(story.story_type)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.description, story?.acceptance_criteria, story?.story_type])

  function updateAcceptanceCriterion(key: number, text: string) {
    setLocalAcceptanceCriteria((rows) => rows.map((row) => (row.key === key ? { ...row, text } : row)))
  }

  function deleteAcceptanceCriterion(key: number) {
    setLocalAcceptanceCriteria((rows) => rows.filter((row) => row.key !== key))
  }

  function addAcceptanceCriterion() {
    setLocalAcceptanceCriteria((rows) => [...rows, makeAcRow('')])
  }

  const localAcTexts = localAcceptanceCriteria.map((row) => row.text)
  const hasChanges =
    !!story &&
    (localDescription !== savedDescription ||
      localStoryType !== savedStoryType ||
      JSON.stringify(localAcTexts) !== JSON.stringify(savedAcceptanceCriteria))

  async function handleSaveChanges() {
    if (!story || !hasChanges) return
    setIsSaving(true)
    setSaveError(null)
    try {
      const response = await apiClient.put<Run>(`/runs/${runId}/stories/${story.id}`, {
        description: localDescription,
        acceptance_criteria: localAcTexts,
        story_type: localStoryType,
      })
      onRunUpdated(response.data)
      flashSaveSucceeded()
    } catch (err) {
      setSaveError(extractErrorMessage(err, 'Failed to save story changes.'))
    } finally {
      setIsSaving(false)
    }
  }

  // Per the story-generation prompt, [NEEDS CLARIFICATION] flags land in
  // the acceptance criteria, not the division summary — once a story
  // exists, its (locally-edited, so this updates live as the PO edits) AC
  // list is the authoritative source for the flag, not item.summary.
  const isFlagged = story
    ? localAcTexts.some((ac) => ac.startsWith('[NEEDS CLARIFICATION]'))
    : needsClarification(item)

  return (
    // Overlay closes on backdrop click, same convention as
    // MergePreviewModal/DeleteConfirmModal — the inner panel stops
    // propagation so clicking inside it doesn't also close it.
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className={`themed-scroll flex h-full w-full max-w-xl flex-col overflow-y-auto border-l bg-abyss p-6 shadow-2xl ${
          isFlagged ? 'border-l-4 border-l-amber' : 'border-white/15'
        }`}
      >
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-md text-lg text-white/40 transition-colors hover:bg-white/10 hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="inline-block rounded-full border border-indigo/30 bg-glass px-2 py-0.5 font-mono text-xs text-indigo">
            {item.id}
          </span>

          {isTitleEditing ? (
            <input
              ref={titleInputRef}
              type="text"
              value={localTitle}
              onChange={(event) => setLocalTitle(event.target.value)}
              onBlur={commitTitleEdit}
              className="-mx-1 mt-2 block w-full rounded border-b border-dashed border-indigo bg-transparent px-1 font-display text-base font-semibold text-white outline-none"
            />
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsTitleEditing(true)}
                className="-mx-1 block w-full cursor-text rounded px-1 py-0.5 text-left font-display text-base font-semibold text-white transition-colors hover:bg-white/5"
              >
                {localTitle || <span className="text-white/30">Title — click to add</span>}
              </button>
              {titleJustSaved && <span className="shrink-0 text-xs text-teal">Saved</span>}
            </div>
          )}

          {isSummaryEditing ? (
            <AutoGrowTextarea
              value={localSummary}
              onChange={(event) => setLocalSummary(event.target.value)}
              onBlur={commitSummaryEdit}
              autoFocus
              rows={2}
              className="-mx-1 mt-2 w-full rounded border-b border-dashed border-indigo bg-transparent px-1 text-sm text-white/70 outline-none"
            />
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsSummaryEditing(true)}
                className="-mx-1 block w-full cursor-text rounded px-1 py-0.5 text-left text-sm text-white/70 transition-colors hover:bg-white/5"
              >
                {localSummary || <span className="text-white/30">Summary — click to add</span>}
              </button>
              {summaryJustSaved && <span className="shrink-0 text-xs text-teal">Saved</span>}
            </div>
          )}

          {divisionSaveError && <p className="mt-1 text-xs text-red-400">{divisionSaveError}</p>}
        </div>

        {story && (
          <div className="shrink-0">
            {isConfirmingRegenerate ? (
              <div className="flex items-center gap-2 rounded-md border border-amber/30 bg-amber/10 px-3 py-1.5 text-xs text-amber">
                <span className="whitespace-nowrap">This will replace the current story.</span>
                <button
                  type="button"
                  onClick={() => {
                    setIsConfirmingRegenerate(false)
                    onGenerate()
                  }}
                  className="font-medium underline decoration-dotted hover:text-white"
                >
                  Regenerate
                </button>
                <button
                  type="button"
                  onClick={() => setIsConfirmingRegenerate(false)}
                  className="text-white/50 hover:text-white"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsConfirmingRegenerate(true)}
                disabled={isGenerating}
                className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-white/15 px-3 py-1.5 text-xs font-medium text-white/60 transition-colors hover:border-indigo/40 hover:text-indigo disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshIcon className={`h-3.5 w-3.5 ${isGenerating ? 'animate-spin' : ''}`} />
                Regenerate
              </button>
            )}
          </div>
        )}
      </div>

      {cardError && <p className="mt-2 text-sm text-red-400">{cardError}</p>}

      {!story ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={onGenerate}
            disabled={isGenerating}
            className="rounded-md bg-indigo px-4 py-1.5 text-sm font-medium text-white shadow-lg shadow-indigo/30 transition-shadow hover:shadow-indigo/50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isGenerating ? (
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
                Generating…
              </span>
            ) : (
              'Generate User Story'
            )}
          </button>
        </div>
      ) : (
        <EditableStoryContent
          storyType={localStoryType}
          onStoryTypeChange={setLocalStoryType}
          description={localDescription}
          onDescriptionChange={setLocalDescription}
          acceptanceCriteria={localAcceptanceCriteria}
          onUpdateCriterion={updateAcceptanceCriterion}
          onDeleteCriterion={deleteAcceptanceCriterion}
          onAddCriterion={addAcceptanceCriterion}
          hasChanges={hasChanges}
          isSaving={isSaving}
          saveError={saveError}
          saveJustSucceeded={saveJustSucceeded}
          onSaveChanges={handleSaveChanges}
        >
          <div className="mt-4">
            <DivisionItemAttachmentsSection runId={runId} item={item} onRunUpdated={onRunUpdated} />
          </div>
        </EditableStoryContent>
      )}
      </div>
    </div>
  )
}
