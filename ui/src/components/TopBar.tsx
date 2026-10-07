// Global top bar, rendered once in App.tsx above all routes. Replaces the
// old HomePage-only permanent left sidebar — the runs list now lives
// behind the "Runs" dropdown on the right instead.
//
// The middle slot is route-aware: RunPage used to render its own "←
// New Run"/Proxi row (plus a run-id pill, dropped outright) directly below
// this bar; both are consolidated into this single row now instead, shown
// only while actually on a run page — TopBar sits above <Routes> in
// App.tsx (a sibling, not a descendant of the /runs/:runId route), so it
// can't read runId via useParams() and checks the path via useLocation()
// instead. HomePage keeps the plain "No Active Run" placeholder.

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { apiClient } from '../api/client'
import { SignalBadge } from './SignalBadge'

interface Run {
  run_id: string
  status: string
  created_at: string
}

interface ClearAllRunsResponse {
  deleted: number
}

export function TopBar() {
  const navigate = useNavigate()
  const location = useLocation()
  const isOnRunPage = /^\/runs\/[^/]+/.test(location.pathname)

  const [isOpen, setIsOpen] = useState(false)
  const [runs, setRuns] = useState<Run[]>([])
  const [hasLoaded, setHasLoaded] = useState(false)

  // "Clear all runs" — destructive, so it's gated behind its own
  // confirmation dialog (isConfirmingClearAll) rather than firing on a
  // single click. clearAllError is scoped to that dialog (shown inside
  // it, dialog stays open on failure so the PO sees why and can retry
  // without re-triggering the whole confirm flow); clearAllSuccessMessage
  // is scoped to the dropdown panel instead, since by the time it has
  // something to say the dialog has already closed.
  const [isConfirmingClearAll, setIsConfirmingClearAll] = useState(false)
  const [isClearingAll, setIsClearingAll] = useState(false)
  const [clearAllError, setClearAllError] = useState<string | null>(null)
  const [clearAllSuccessMessage, setClearAllSuccessMessage] = useState<string | null>(null)
  const successMessageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (successMessageTimeoutRef.current) clearTimeout(successMessageTimeoutRef.current)
    }
  }, [])

  useEffect(() => {
    if (!isOpen || hasLoaded) return
    apiClient
      .get<Run[]>('/runs')
      .then((response) => setRuns(response.data))
      .catch(() => {})
      .finally(() => setHasLoaded(true))
  }, [isOpen, hasLoaded])

  function goToRun(runId: string) {
    setIsOpen(false)
    navigate(`/runs/${runId}`)
  }

  function openClearAllConfirm() {
    setClearAllError(null)
    setIsConfirmingClearAll(true)
  }

  function cancelClearAllConfirm() {
    if (isClearingAll) return
    setClearAllError(null)
    setIsConfirmingClearAll(false)
  }

  async function handleConfirmClearAll() {
    setIsClearingAll(true)
    setClearAllError(null)
    try {
      const response = await apiClient.delete<ClearAllRunsResponse>('/runs')
      // Cleared immediately — the dropdown's existing "No runs yet." empty
      // state (below) picks this up with no extra markup needed.
      setRuns([])
      setIsConfirmingClearAll(false)

      const count = response.data.deleted
      if (successMessageTimeoutRef.current) clearTimeout(successMessageTimeoutRef.current)
      setClearAllSuccessMessage(`${count} run${count === 1 ? '' : 's'} deleted.`)
      successMessageTimeoutRef.current = setTimeout(() => setClearAllSuccessMessage(null), 3000)
    } catch {
      // Dialog stays open (isConfirmingClearAll untouched) — the PO sees
      // the error right where they confirmed, can retry or cancel from
      // there. `runs` is untouched too: nothing here ever set it to [],
      // so the list is exactly what it was before the attempt.
      setClearAllError('Failed to delete runs. Nothing was removed.')
    } finally {
      setIsClearingAll(false)
    }
  }

  return (
    <header className="relative flex items-center justify-between border-b border-white/10 bg-void px-6 py-3">
      <span className="font-display text-sm font-bold tracking-widest text-teal">Pencil</span>

      {isOnRunPage ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
            New Run
          </button>
          <div className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-teal shadow-[0_0_6px_2px_rgba(63,224,197,0.5)]" />
            <span className="font-mono text-xs uppercase tracking-wide text-white/40">Proxi</span>
          </div>
        </div>
      ) : (
        <span className="font-mono text-xs uppercase tracking-widest text-white/30">
          No Active Run
        </span>
      )}

      <div className="relative">
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          className="rounded-md border border-white/10 bg-glass px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-white/70 backdrop-blur-md transition-colors hover:border-indigo/40 hover:text-indigo"
        >
          Runs
        </button>

        {isOpen && (
          <div className="absolute right-0 top-full z-10 mt-2 w-72 rounded-xl border border-white/10 bg-abyss/95 p-2 shadow-lg backdrop-blur-md">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-white/30">
                Runs
              </span>
              {/* Muted/quiet on purpose — clay is this app's established
                  destructive-action color (see e.g. DeleteConfirmModal),
                  but a plain text-only ghost button here, not a filled
                  clay button — this is a secondary action tucked into a
                  dropdown, not the primary thing on screen. Only shown
                  once there's actually something to clear. */}
              {hasLoaded && runs.length > 0 && (
                <button
                  type="button"
                  onClick={openClearAllConfirm}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-white/40 transition-colors hover:text-clay"
                >
                  <Trash2 className="h-3 w-3" strokeWidth={2} />
                  Clear all
                </button>
              )}
            </div>

            {clearAllSuccessMessage && (
              <p className="mb-1 rounded-md border border-teal/30 bg-teal/10 px-2.5 py-1.5 text-xs text-teal">
                {clearAllSuccessMessage}
              </p>
            )}

            {!hasLoaded && <p className="px-3 py-2 text-sm text-white/40">Loading…</p>}
            {hasLoaded && runs.length === 0 && (
              <p className="px-3 py-2 text-sm text-white/40">No runs yet.</p>
            )}
            {runs.map((run) => (
              <button
                key={run.run_id}
                type="button"
                onClick={() => goToRun(run.run_id)}
                className="flex w-full flex-col items-start gap-1 rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/5"
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="font-mono text-xs text-white/80">
                    {run.run_id.slice(0, 8)}
                  </span>
                  <SignalBadge status={run.status} />
                </div>
                <span className="text-xs text-white/30">{run.created_at}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {isConfirmingClearAll && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
          onClick={cancelClearAllConfirm}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-sm rounded-xl border border-clay/30 bg-abyss p-5 shadow-2xl shadow-black/50"
          >
            <h2 className="font-display text-base font-semibold text-white">Clear all runs?</h2>
            <p className="mt-2 text-sm text-white/60">
              Delete all {runs.length} run{runs.length === 1 ? '' : 's'} and their uploaded files?
              This can't be undone. Published JIRA stories are not affected.
            </p>

            {clearAllError && <p className="mt-3 text-xs text-red-400">{clearAllError}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelClearAllConfirm}
                disabled={isClearingAll}
                className="rounded-md border border-white/10 px-4 py-2 text-sm text-white/70 transition-colors hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmClearAll}
                disabled={isClearingAll}
                className="rounded-md bg-clay px-4 py-2 text-sm font-medium text-white shadow-lg shadow-clay/30 transition-shadow hover:shadow-clay/50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isClearingAll ? (
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
                    Deleting…
                  </span>
                ) : (
                  'Delete All'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  )
}
