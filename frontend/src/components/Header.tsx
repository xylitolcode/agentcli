type Props = {
  /** 顶部右侧那行字：未选项目时是根路径，进了项目是「项目名 · 路径」 */
  label: string
  /** 搜索按项目根收窄路径，未选项目时不给入口 —— 给了也点不开 */
  onSearch?: () => void
}

export function Header({ label, onSearch }: Props) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-2">
      <h1 className="m-0 text-[13px] font-semibold tracking-[0.4px]">
        agentcli <span className="font-normal text-dim">· web console</span>
      </h1>
      {onSearch && (
        <button
          onClick={onSearch}
          className="flex shrink-0 items-center gap-1.5 rounded-[5px] border border-line px-2 py-1 text-[11px] text-dim hover:bg-line-soft hover:text-fg"
          title="全项目搜索：文件名与内容（Ctrl+Shift+F）"
        >
          搜索
          <kbd className="rounded-[3px] border border-line px-1 text-[9.5px] text-faint">
            Ctrl+Shift+F
          </kbd>
        </button>
      )}
      <div className="ml-auto max-w-[46vw] truncate text-xs text-faint" title={label}>
        {label}
      </div>
    </header>
  )
}
