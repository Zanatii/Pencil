// Shared, session-cached fetch of the PO's Claude.ai Projects
// (GET /claude-projects), for HomePage's project picker.
//
// Root cause this exists to fix: the fetch used to be owned by a
// useEffect scoped to isAdvancedOpen (the dropdown's own open/closed
// state), with a `cancelled` flag set in that effect's cleanup. Toggling
// Advanced Settings closed BEFORE the ~13s Proxi round trip resolved ran
// that cleanup — not because anything actually unmounted (HomePage
// itself never does across that toggle), but because isAdvancedOpen
// changing was the effect's own dependency. That flipped `cancelled` to
// true, so when the original request finished in the background, its
// `.then`/`.catch`/`.finally` all silently no-op'd on the stale
// `cancelled` check — including the one call that would have reset
// isLoadingProjects back to false. Reopening the dropdown then found
// isLoadingProjects permanently stuck true, and the effect's own guard
// (which required !isLoadingProjects before starting a new fetch) meant
// no fetch would ever be attempted again either. Permanently stuck.
//
// The fix isn't a smarter cancellation flag — it's not tying the fetch's
// lifecycle to the dropdown's open/closed state at all. State here lives
// at module scope (not component/effect scope), so it survives the
// dropdown closing, HomePage re-rendering, or even HomePage unmounting
// and remounting (e.g. navigating to a run and back to "New Run") within
// the same browser session — a full page reload is the only thing that
// resets it, same as any other in-memory cache.
import { useCallback, useEffect, useState } from 'react'
import { apiClient } from '../api/client'

export interface ClaudeProject {
  id: string
  name: string
}

export type ClaudeProjectsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; projects: ClaudeProject[] }
  | { status: 'error'; message: string }

// GET /claude-projects is a real Proxi round trip (drives Claude.ai via
// Playwright), not a fast local lookup — confirmed live, it can take
// 10+ seconds. 15s gives it real headroom while still guaranteeing the
// PO never faces a truly infinite spinner: past this, the request
// aborts and the hook surfaces an error/retry state instead.
const FETCH_TIMEOUT_MS = 15000

let cachedState: ClaudeProjectsState = { status: 'idle' }
// The single in-flight request, if any — a second startFetch() call
// while one's already pending reuses this instead of firing a duplicate
// request, regardless of how many components/instances asked.
let inFlightPromise: Promise<void> | null = null
// Every mounted useClaudeProjects() call registers a listener here so it
// re-renders when the shared cache changes — including a fetch that
// resolves after the component that originally triggered it has already
// unmounted/re-rendered for unrelated reasons; the result still lands
// correctly for whichever instance(s) are subscribed at the time.
const listeners = new Set<() => void>()

function setCachedState(next: ClaudeProjectsState) {
  cachedState = next
  listeners.forEach((listener) => listener())
}

function startFetch(): Promise<void> {
  if (inFlightPromise) return inFlightPromise

  setCachedState({ status: 'loading' })

  inFlightPromise = apiClient
    .get<ClaudeProject[]>('/claude-projects', { timeout: FETCH_TIMEOUT_MS })
    .then((response) => {
      setCachedState({ status: 'success', projects: response.data })
    })
    .catch(() => {
      // Covers both a real error response and axios's own timeout abort
      // (ECONNABORTED) — the PO doesn't need to tell those apart, both
      // just mean "try again" via the Retry affordance the caller wires
      // up to retryClaudeProjectsFetch.
      setCachedState({ status: 'error', message: 'Failed to load Claude projects.' })
    })
    .finally(() => {
      inFlightPromise = null
    })

  return inFlightPromise
}

export function useClaudeProjects() {
  const [state, setState] = useState(cachedState)

  useEffect(() => {
    // Cache may already have moved on between this hook instance's
    // initial useState(cachedState) capture and this effect running
    // (e.g. remounting into an already-loading or already-loaded cache)
    // — resync once on mount, then stay live via the listener.
    setState(cachedState)
    const listener = () => setState(cachedState)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  // Auto-fetch trigger — only ever starts a request from a genuinely
  // untouched ('idle') cache. Safe to call on every dropdown open: once
  // loading or successful, this is a no-op (satisfies "don't refetch on
  // reopen"); once errored, this ALSO stays a no-op deliberately — an
  // automatic retry on every reopen would silently hammer a possibly
  // persistently-broken Proxi connection. Recovering from an error is
  // only ever a deliberate PO action, via retry below.
  const fetchProjects = useCallback(() => {
    if (cachedState.status !== 'idle') return
    startFetch()
  }, [])

  // Deliberate manual retry — allowed regardless of current status,
  // though the only sensible time to expose it in the UI is while
  // status is 'error'.
  const retryFetchProjects = useCallback(() => {
    startFetch()
  }, [])

  // Folds a just-created project into the shared cache (see
  // HomePage.tsx's handleCreateProject) so it shows up immediately
  // without a refetch — appended onto an existing successful list, or
  // starting a fresh one-item 'success' state if the cache was
  // idle/loading/error at the time (a successful creation is a good
  // reason to move past an error state on its own, without waiting for
  // an explicit retry of the original list fetch).
  const addCreatedProject = useCallback((project: ClaudeProject) => {
    const currentProjects = cachedState.status === 'success' ? cachedState.projects : []
    setCachedState({ status: 'success', projects: [...currentProjects, project] })
  }, [])

  return { state, fetchProjects, retryFetchProjects, addCreatedProject }
}
