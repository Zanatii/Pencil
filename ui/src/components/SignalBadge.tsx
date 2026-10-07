// Small pill badge with a glowing status dot + a human-readable status
// phrase in sentence case, on a translucent glass background. Replaces the
// old StatusStamp.

import { statusLabel } from '../lib/statusLabel'

interface SignalBadgeProps {
  status: string
}

type Variant = 'active' | 'done' | 'clarification' | 'failed'

function getVariant(status: string): Variant {
  if (status === 'FAILED') return 'failed'
  if (status === 'DONE') return 'done'
  if (status.includes('NEEDS_CLARIFICATION')) return 'clarification'
  return 'active'
}

const DOT_CLASSES: Record<Variant, string> = {
  active: 'animate-pulse bg-indigo shadow-[0_0_8px_2px_rgba(124,111,242,0.6)]',
  done: 'bg-teal shadow-[0_0_8px_2px_rgba(63,224,197,0.6)]',
  clarification: 'bg-amber shadow-[0_0_8px_2px_rgba(242,169,63,0.6)]',
  failed: 'bg-red-500 shadow-[0_0_8px_2px_rgba(239,68,68,0.6)]',
}

const BORDER_CLASSES: Record<Variant, string> = {
  active: 'border-indigo/30',
  done: 'border-teal/30',
  clarification: 'border-amber/30',
  failed: 'border-red-500/30',
}

const TEXT_CLASSES: Record<Variant, string> = {
  active: 'text-indigo',
  done: 'text-teal',
  clarification: 'text-amber',
  failed: 'text-red-400',
}

export function SignalBadge({ status }: SignalBadgeProps) {
  const variant = getVariant(status)

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border ${BORDER_CLASSES[variant]} bg-glass px-3 py-1 backdrop-blur-md`}
    >
      <span className={`h-2 w-2 rounded-full ${DOT_CLASSES[variant]}`} />
      <span className={`font-mono text-xs ${TEXT_CLASSES[variant]}`}>{statusLabel(status)}</span>
    </span>
  )
}
