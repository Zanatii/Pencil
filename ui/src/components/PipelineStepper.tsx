// Vertical 5-node pipeline stepper for RunPage's left rail. Every node is
// clickable — RunPage decides what a click actually navigates to (live
// editing for Write Stories/Review/Publish regardless of order, a
// read-only historical view for Upload/Breakdown once the run has moved
// past them) and hands back three separate pieces of state this component
// needs to render correctly, since "where the run really is" and "what
// the PO is currently looking at" aren't always the same node:
//   - activeIndex: the run's true current progress (steps before this are
//     "completed")
//   - viewedIndex: what's actually on screen right now — may sit behind
//     activeIndex during a read-only revisit; this is what gets the
//     animated ring, not activeIndex
//   - maxReachableIndex: the furthest node the PO can click into at all,
//     given what data the run has produced so far
//
// Deliberately still compact — small icons, tight spacing — per-step
// lucide icons replace the old numbered-circle/checkmark scheme, but the
// footprint stays the same; this isn't the oversized version from earlier
// rounds.

import type { LucideIcon } from 'lucide-react'
import { Eye, Layers, Lock, Pencil, Rocket, UploadCloud } from 'lucide-react'
import { PIPELINE_STAGES } from '../lib/pipelineStages'

const STEP_ICONS: LucideIcon[] = [UploadCloud, Layers, Pencil, Eye, Rocket]

interface PipelineStepperProps {
  activeIndex: number
  viewedIndex: number
  maxReachableIndex: number
  /** True when viewedIndex is a locked historical revisit (Upload/
   *  Breakdown, viewed after the run has moved on) — draws the small lock
   *  badge on that one node so it's clear on the rail too, not just in
   *  the content area, why it's inert. */
  isViewedStepReadOnly: boolean
  onStepClick: (index: number) => void
}

export function PipelineStepper({
  activeIndex,
  viewedIndex,
  maxReachableIndex,
  isViewedStepReadOnly,
  onStepClick,
}: PipelineStepperProps) {
  return (
    <div className="flex flex-col">
      {PIPELINE_STAGES.map((label, index) => {
        const Icon = STEP_ICONS[index]
        const isViewed = index === viewedIndex
        const isCompleted = !isViewed && index < activeIndex
        const isReachable = index <= maxReachableIndex
        const isLast = index === PIPELINE_STAGES.length - 1

        return (
          <button
            key={label}
            type="button"
            onClick={() => onStepClick(index)}
            disabled={!isReachable}
            className="group flex w-full items-start gap-3 rounded-lg px-2 py-1 text-left transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <div className="flex flex-col items-center">
              <div className="relative flex h-6 w-6 shrink-0 items-center justify-center">
                {isViewed && (
                  // The "in progress/live" cue — a slow conic-gradient ring,
                  // not the plain animate-spin dot spinner used for inline
                  // loading elsewhere (e.g. Generating…/Saving… states).
                  // Masked to a ring (transparent center) same trick as the
                  // old SpinnerRing, just a wider fading trail and a much
                  // slower rotation so it reads as ambient/alive rather
                  // than "busy".
                  <span
                    className="absolute inset-0 animate-[spin_3s_linear_infinite] rounded-full"
                    style={{
                      background:
                        'conic-gradient(from 0deg, rgba(124,111,242,0) 0deg, #7C6FF2 300deg, rgba(124,111,242,0) 360deg)',
                      WebkitMask:
                        'radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px))',
                      mask: 'radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px))',
                    }}
                  />
                )}
                <div
                  className={
                    isViewed
                      ? 'flex h-5 w-5 items-center justify-center rounded-full border border-indigo/40 text-indigo'
                      : isCompleted
                        ? 'flex h-5 w-5 items-center justify-center rounded-full border border-teal/50 text-teal'
                        : 'flex h-5 w-5 items-center justify-center rounded-full border border-slate-500/40 text-slate-500'
                  }
                >
                  <Icon className="h-3 w-3" strokeWidth={2} />
                </div>
                {isViewed && isViewedStepReadOnly && (
                  <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full border border-abyss bg-white/15 text-white/70">
                    <Lock className="h-2 w-2" strokeWidth={2.5} />
                  </span>
                )}
              </div>

              {/* Thin connector, gradient-brightened toward whichever end
                  (top or bottom) is completed/active — a flat low-opacity
                  line between two upcoming nodes, same quiet-connector
                  intent as before. */}
              {!isLast && (
                <div
                  className={`my-1 w-px flex-1 bg-gradient-to-b ${
                    isCompleted || isViewed ? 'from-teal/40 to-white/10' : 'from-slate-500/15 to-slate-500/15'
                  }`}
                  style={{ minHeight: '1rem' }}
                />
              )}
            </div>

            <div className={isLast ? 'pt-0.5' : 'pb-4 pt-0.5'}>
              <span
                className={
                  isViewed
                    ? 'font-mono text-sm font-bold text-indigo'
                    : isCompleted
                      ? 'font-mono text-sm text-white/70'
                      : 'font-mono text-sm text-slate-500'
                }
              >
                {label}
              </span>
              {isViewed && (
                <span className="ml-1.5 font-mono text-[9px] uppercase tracking-wide text-indigo/60">
                  · viewing
                </span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
