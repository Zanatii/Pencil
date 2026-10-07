import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type SubmitEvent,
} from 'react'
import axios from 'axios'
import { useNavigate } from 'react-router-dom'
import { apiClient } from '../api/client'
import { FileTypeBadge } from '../components/FileTypeBadge'
import { useClaudeProjects } from '../hooks/useClaudeProjects'
import { PIPELINE_STAGES } from '../lib/pipelineStages'

const ACCEPTED_EXTENSIONS = '.pdf,.docx,.xlsx,.xls,.png,.jpg,.jpeg,.webp,.txt'

// Sentinel <option value=...> for "+ Create new project..." — distinct
// from "" (which means "no project"/independent chats, the dropdown's own
// default) so selecting it can be told apart from clearing the selection.
const CREATE_PROJECT_OPTION = '__create__'

interface Run {
  run_id: string
  status: string
}

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      <path d="M14 3v5h5" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M12 15V4m0 0L8 8m4-4 4 4"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className}>
      <path
        d="M5 5l10 10M15 5 5 15"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
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

// Centered "launch" screen. Run list lives in the global TopBar dropdown
// now, not here — this page is just the pipeline-launch card.

export function HomePage() {
  const navigate = useNavigate()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [pastedText, setPastedText] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)

  // Fetch/loading state lives outside this component entirely (see the
  // hook's own module docstring for why) — HomePage just derives the
  // three flat values the JSX below already expects from whichever
  // discriminated-union status the shared cache is currently in.
  const { state: claudeProjectsState, fetchProjects, retryFetchProjects, addCreatedProject } =
    useClaudeProjects()
  const projects = claudeProjectsState.status === 'success' ? claudeProjectsState.projects : []
  const isLoadingProjects = claudeProjectsState.status === 'loading'
  const projectsError = claudeProjectsState.status === 'error' ? claudeProjectsState.message : null
  // '' = no project (independent chats, the dropdown's own default) —
  // never null, so it binds directly to the <select>'s value without a
  // null-to-'' translation at every read/write site.
  const [selectedProjectId, setSelectedProjectId] = useState('')
  // Selecting CREATE_PROJECT_OPTION shows the name/description mini-form
  // below the dropdown instead of immediately committing a selection —
  // selectedProjectId only actually changes once "Create" succeeds (see
  // handleCreateProject), so cancelling out of this (picking something
  // else in the dropdown) never leaves a half-created project selected.
  const [isCreatingNewProject, setIsCreatingNewProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectDescription, setNewProjectDescription] = useState('')
  const [isSubmittingNewProject, setIsSubmittingNewProject] = useState(false)
  const [newProjectError, setNewProjectError] = useState<string | null>(null)

  // Deliberately NOT an unconditional fetch-on-mount — GET /claude-projects
  // is a real Proxi round trip (drives Claude.ai via Playwright, ~13s,
  // opens a debug Chrome tab), not a cheap local lookup. Firing it every
  // time HomePage renders, whether or not the PO ever looks at the
  // project dropdown, wastes that entire round trip on every page load.
  // This just triggers the shared fetch when the section opens;
  // fetchProjects itself (see useClaudeProjects) is the one that
  // actually decides whether that means starting a new request or
  // no-op'ing against an already-loading/already-loaded/already-failed
  // cache — that decision, and the fetch's whole lifecycle, live outside
  // this component now, so closing Advanced Settings before the request
  // resolves can no longer strand it: there's no cleanup here to cancel
  // anything, because isAdvancedOpen toggling isn't what the fetch's
  // lifecycle is tied to anymore.
  useEffect(() => {
    if (isAdvancedOpen) fetchProjects()
  }, [isAdvancedOpen, fetchProjects])

  function handleProjectSelectChange(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value
    if (value === CREATE_PROJECT_OPTION) {
      setIsCreatingNewProject(true)
      setNewProjectError(null)
      return
    }
    setIsCreatingNewProject(false)
    setSelectedProjectId(value)
  }

  async function handleCreateProject() {
    const name = newProjectName.trim()
    if (!name || isSubmittingNewProject) return

    setIsSubmittingNewProject(true)
    setNewProjectError(null)
    try {
      const response = await apiClient.post<{ project_id: string }>('/claude-projects', {
        name,
        description: newProjectDescription.trim(),
      })
      const projectId = response.data.project_id
      addCreatedProject({ id: projectId, name })
      setSelectedProjectId(projectId)
      setIsCreatingNewProject(false)
      setNewProjectName('')
      setNewProjectDescription('')
    } catch (err) {
      const detail = axios.isAxiosError(err) ? err.response?.data?.detail : undefined
      setNewProjectError(typeof detail === 'string' && detail ? detail : 'Failed to create project.')
    } finally {
      setIsSubmittingNewProject(false)
    }
  }

  const hasFiles = selectedFiles.length > 0
  const hasPastedText = pastedText.trim().length > 0
  const canCreate = (hasFiles || hasPastedText) && !isCreating

  function openFilePicker() {
    fileInputRef.current?.click()
  }

  function handleDropzoneKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openFilePicker()
    }
  }

  function handleFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    // event.target.files is a *live* FileList tied to the input node, not a
    // snapshot — it must be copied into a plain array right here, before
    // event.target.value is reset below. React defers the setSelectedFiles
    // updater to the render phase, which runs after this handler returns;
    // by then the live FileList has already been cleared, so reading it
    // lazily inside the updater silently added zero files.
    const picked = Array.from(event.target.files ?? [])
    if (picked.length > 0) {
      setSelectedFiles((prev) => [...prev, ...picked])
    }
    // Reset so picking the exact same file again still fires onChange.
    event.target.value = ''
  }

  function removeFile(index: number) {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleCreateRun(event: SubmitEvent) {
    event.preventDefault()
    if (!canCreate) return

    setIsCreating(true)
    setCreateError(null)

    const formData = new FormData()
    for (const file of selectedFiles) {
      formData.append('files', file)
    }
    formData.append('pasted_text', pastedText)
    // Only appended when a project is actually selected — the backend's
    // claude_project_id is Form(default=None), and it checks `is not
    // None` (not truthiness) before forwarding it to Proxi, so sending an
    // empty-string field here would incorrectly register as "a project
    // was picked" server-side instead of correctly resolving to unset.
    if (selectedProjectId) {
      formData.append('claude_project_id', selectedProjectId)
    }

    try {
      const response = await apiClient.post<Run>('/runs', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      navigate(`/runs/${response.data.run_id}`)
    } catch {
      setCreateError('Failed to create run.')
      setIsCreating(false)
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-3.25rem)] items-center justify-center bg-void-gradient px-4 py-12 font-body">
      <div className="w-full max-w-[600px] rounded-2xl border border-white/15 bg-glass p-8 backdrop-blur-md">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-teal/40 bg-glass shadow-[0_0_20px_rgba(63,224,197,0.25)]">
            <DocumentIcon className="h-6 w-6 text-teal" />
          </div>
          <h1 className="font-display text-3xl font-bold text-white">PO Pencil</h1>
          <p className="text-sm text-white/50">Turn requirements into JIRA user stories</p>
        </div>

        <div className="mt-6 flex items-center justify-center gap-1.5">
          {PIPELINE_STAGES.map((stage, index) => (
            <div key={stage} className="flex items-center gap-1.5">
              <span className="rounded-full border border-indigo/30 bg-glass px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-indigo">
                {stage}
              </span>
              {index < PIPELINE_STAGES.length - 1 && <span className="h-px w-3 bg-white/10" />}
            </div>
          ))}
        </div>

        <div className="mt-6 flex items-center gap-2 rounded-lg border border-white/10 bg-void/30 px-3 py-2">
          <span className="h-1.5 w-1.5 rounded-full bg-teal shadow-[0_0_6px_2px_rgba(63,224,197,0.5)]" />
          <span className="font-mono text-xs uppercase tracking-wide text-white/70">
            JIRA — Connected
          </span>
        </div>

        <form className="mt-6 flex flex-col gap-4" onSubmit={handleCreateRun}>
          <div
            role="button"
            tabIndex={0}
            onClick={openFilePicker}
            onKeyDown={handleDropzoneKeyDown}
            className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/15 bg-void/20 px-4 text-center transition-colors hover:border-indigo/40 ${
              hasFiles ? 'py-4' : 'py-8'
            }`}
          >
            {hasFiles ? (
              <div className="flex w-full flex-col gap-1.5">
                {selectedFiles.map((file, index) => (
                  <div
                    key={`${file.name}-${file.size}-${index}`}
                    className="flex items-center gap-2 rounded-md border border-white/10 bg-void/30 px-2.5 py-1.5 text-left"
                  >
                    <FileTypeBadge filename={file.name} />
                    <span className="min-w-0 flex-1 truncate text-sm text-white/80">
                      {file.name}
                    </span>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        removeFile(index)
                      }}
                      aria-label={`Remove ${file.name}`}
                      className="shrink-0 rounded p-0.5 text-white/40 transition-colors hover:text-red-400"
                    >
                      <CloseIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <span className="mt-1 text-xs text-white/40">Click to add more files</span>
              </div>
            ) : (
              <>
                <UploadIcon className="h-6 w-6 text-white/30" />
                <span className="text-sm text-white/50">
                  Click to attach PDF, DOCX, XLSX, PNG, JPG, or TXT
                </span>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_EXTENSIONS}
              onChange={handleFilesPicked}
              className="hidden"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-white/80">
              Or paste requirements text
            </label>
            <textarea
              value={pastedText}
              onChange={(event) => setPastedText(event.target.value)}
              rows={5}
              className="mt-1 block w-full rounded-md border border-white/10 bg-void/40 p-2 text-sm text-white/90 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
              placeholder="Paste BRD/CR text here…"
            />
          </div>

          <div className="rounded-lg border border-white/10">
            <button
              type="button"
              onClick={() => setIsAdvancedOpen((open) => !open)}
              className="flex w-full items-center justify-between px-3 py-2 text-sm text-white/60 transition-colors hover:text-white/80"
            >
              <span>Advanced Settings</span>
              <ChevronIcon
                className={`h-4 w-4 transition-transform ${isAdvancedOpen ? 'rotate-180' : ''}`}
              />
            </button>
            {isAdvancedOpen && (
              <div className="flex flex-col gap-2 border-t border-white/10 px-3 py-3">
                <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                  Claude Project
                </label>
                <div className="relative">
                  <select
                    value={isCreatingNewProject ? CREATE_PROJECT_OPTION : selectedProjectId}
                    onChange={handleProjectSelectChange}
                    disabled={isLoadingProjects}
                    className="block w-full appearance-none rounded-md border border-white/10 bg-void/40 py-2 pl-2 pr-8 text-sm text-white/90 outline-none focus:border-indigo focus:ring-1 focus:ring-indigo disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="">
                      {isLoadingProjects ? 'Loading projects…' : '— No project (independent chats) —'}
                    </option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                    <option value={CREATE_PROJECT_OPTION}>+ Create new project...</option>
                  </select>
                  {isLoadingProjects ? (
                    // GET /claude-projects is a real Proxi round trip (it
                    // drives Claude.ai via Playwright to list projects),
                    // not a fast local lookup — confirmed live, it can
                    // take upwards of 10+ seconds. A static disabled
                    // select with plain option text is easy to read as
                    // "broken" over a wait that long; a spinner in the
                    // dropdown's own icon slot (replacing the chevron
                    // outright, not just alongside it) makes the pending
                    // state unmistakable regardless of when the PO
                    // happens to open Advanced Settings relative to when
                    // the fetch kicked off on mount.
                    <span
                      className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-white/20 border-t-indigo"
                      aria-hidden="true"
                    />
                  ) : (
                    <ChevronIcon className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
                  )}
                </div>

                {projectsError && (
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-red-400">{projectsError}</p>
                    <button
                      type="button"
                      onClick={retryFetchProjects}
                      className="shrink-0 text-xs font-medium text-indigo transition-colors hover:text-indigo/80"
                    >
                      Retry
                    </button>
                  </div>
                )}

                {isCreatingNewProject && (
                  <div className="mt-1 flex flex-col gap-2 rounded-md border border-white/10 bg-void/20 p-2.5">
                    <input
                      type="text"
                      value={newProjectName}
                      onChange={(event) => setNewProjectName(event.target.value)}
                      placeholder="Project name"
                      className="block w-full rounded-md border border-white/10 bg-void/40 p-2 text-sm text-white/90 outline-none placeholder:text-white/30 focus:border-indigo focus:ring-1 focus:ring-indigo"
                    />
                    <input
                      type="text"
                      value={newProjectDescription}
                      onChange={(event) => setNewProjectDescription(event.target.value)}
                      placeholder="Description (optional)"
                      className="block w-full rounded-md border border-white/10 bg-void/40 p-2 text-sm text-white/90 outline-none placeholder:text-white/30 focus:border-indigo focus:ring-1 focus:ring-indigo"
                    />
                    {newProjectError && <p className="text-xs text-red-400">{newProjectError}</p>}
                    <button
                      type="button"
                      onClick={handleCreateProject}
                      disabled={!newProjectName.trim() || isSubmittingNewProject}
                      className="self-end rounded-md border border-white/10 bg-glass px-3 py-1.5 text-xs text-white/80 transition-colors hover:border-indigo/40 hover:text-indigo disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {isSubmittingNewProject ? 'Creating…' : 'Create'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {createError && <p className="text-sm text-red-400">{createError}</p>}

          <button
            type="submit"
            disabled={!canCreate}
            className="w-full rounded-xl bg-gradient-to-r from-indigo to-teal px-6 py-3.5 text-sm font-semibold text-void shadow-lg shadow-indigo/30 transition-shadow hover:shadow-indigo/50 disabled:cursor-not-allowed disabled:bg-none disabled:bg-white/10 disabled:text-white/30 disabled:shadow-none"
          >
            {isCreating ? 'Launching…' : 'Launch Pipeline →'}
          </button>
        </form>
      </div>
    </div>
  )
}
