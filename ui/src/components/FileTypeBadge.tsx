type FileKind = 'pdf' | 'docx' | 'xlsx' | 'image' | 'txt' | 'other'

const FILE_KIND_META: Record<FileKind, { label: string; className: string }> = {
  pdf: { label: 'PDF', className: 'border-red-400/40 text-red-300' },
  docx: { label: 'DOC', className: 'border-indigo/40 text-indigo' },
  xlsx: { label: 'XLS', className: 'border-amber/40 text-amber' },
  image: { label: 'IMG', className: 'border-teal/40 text-teal' },
  txt: { label: 'TXT', className: 'border-white/20 text-white/60' },
  other: { label: 'FILE', className: 'border-white/20 text-white/60' },
}

export function getFileKind(filename: string): FileKind {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx' || ext === 'doc') return 'docx'
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image'
  if (ext === 'txt') return 'txt'
  return 'other'
}

export function FileTypeBadge({ filename }: { filename: string }) {
  const { label, className } = FILE_KIND_META[getFileKind(filename)]
  return (
    <span
      className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${className}`}
    >
      {label}
    </span>
  )
}
