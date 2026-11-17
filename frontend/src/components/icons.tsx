/** 图标全部内联成组件，不引图标库 —— 就这四个，加个依赖不值当。 */

type IconProps = { className?: string }

export function FolderIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M1.9 4.3c0-.6.5-1.1 1.1-1.1h3.1l1.4 1.6h5.5c.6 0 1.1.5 1.1 1.1v6.3c0 .6-.5 1.1-1.1 1.1H3c-.6 0-1.1-.5-1.1-1.1V4.3z" />
    </svg>
  )
}

export function FileIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4.2 1.9h4.6l3 3v9.2H4.2z" />
      <path d="M8.6 1.9v3.2h3.2" />
    </svg>
  )
}

export function EyeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
      strokeWidth="1.3" className={className} aria-hidden="true">
      <path d="M1.6 8s2.5-4.1 6.4-4.1S14.4 8 14.4 8s-2.5 4.1-6.4 4.1S1.6 8 1.6 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </svg>
  )
}

export function RefreshIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" className={className} aria-hidden="true">
      <path d="M13.1 8A5.1 5.1 0 1 1 11.5 4.2" />
      <path d="M13.3 2.3v3.1h-3.1" />
    </svg>
  )
}
