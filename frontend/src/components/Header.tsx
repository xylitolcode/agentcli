type Props = {
  /** 顶部右侧那行字：未选项目时是根路径，进了项目是「项目名 · 路径」 */
  label: string
}

export function Header({ label }: Props) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-2">
      <h1 className="m-0 text-[13px] font-semibold tracking-[0.4px]">
        agentcli <span className="font-normal text-dim">· web console</span>
      </h1>
      <div className="ml-auto max-w-[46vw] truncate text-xs text-faint" title={label}>
        {label}
      </div>
    </header>
  )
}
