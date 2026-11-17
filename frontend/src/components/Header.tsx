import { AnimatePresence, motion } from 'motion/react'

import { EASE } from '../motion'
import type { ConnStatus, RenderMode } from '../types'

type Props = {
  /** 顶部右侧那行字：未选项目时是根路径，进了项目是「项目名 · 路径」 */
  label: string
  /** 搜索按项目根收窄路径，未选项目时不给入口 —— 给了也点不开 */
  onSearch?: () => void
  /** 召唤层入口：命令面板（Ctrl+K）与文件/Git 抽屉（Ctrl+B） */
  onPalette?: () => void
  onFiles?: () => void
  filesOpen?: boolean
  /** 以下四项原属底部状态栏，P0 起并入 HUD：状态是背景信息，不该单独占一条 lane */
  status?: ConnStatus
  renderMode?: RenderMode
  cols?: number
  rows?: number
  fontOk?: boolean
}

const STATUS_TEXT: Record<ConnStatus, string> = {
  connecting: '连接中',
  online: '在线',
  offline: '断开',
  ended: '已结束',
}

/** 顶部 HUD：一行，扫描线压在上面。不是「导航栏」，没有菜单，没有 logo 区。 */
export function Header({
  label,
  onSearch,
  onPalette,
  onFiles,
  filesOpen = false,
  status,
  renderMode,
  cols = 0,
  rows = 0,
  fontOk = true,
}: Props) {
  const chip =
    'flex shrink-0 items-center gap-1.5 rounded-[2px] border border-line px-2 py-[2px] text-[11px] text-dim transition-colors hover:border-accent hover:text-fg'

  return (
    <header className="hud-scan flex shrink-0 items-center gap-3 border-b border-line bg-[rgba(4,7,11,0.92)] px-3 py-[7px] backdrop-blur-[6px]">
      <h1 className="m-0 shrink-0 text-[13px] font-semibold tracking-[0.5px]">
        <span className="brand-glow text-accent">agentcli</span>
        <span className="font-normal text-ghost"> · web console</span>
      </h1>

      {onSearch && (
        <button
          type="button"
          onClick={onSearch}
          className={chip}
          title="全项目搜索：文件名与内容（Ctrl+Shift+F）"
        >
          搜索
          <kbd className="rounded-[1px] border border-line px-1 text-[9.5px] text-faint">
            Ctrl+Shift+F
          </kbd>
        </button>
      )}

      {onPalette && (
        <button
          type="button"
          onClick={onPalette}
          className={chip}
          title="命令面板：动作与文件跳转（Ctrl+K）"
        >
          命令
          <kbd className="rounded-[1px] border border-line px-1 text-[9.5px] text-faint">⌘K</kbd>
        </button>
      )}

      {onFiles && (
        <button
          type="button"
          onClick={onFiles}
          aria-pressed={filesOpen}
          className={chip + (filesOpen ? ' border-accent text-accent' : '')}
          title="文件与 Git 抽屉（Ctrl+B）"
        >
          文件
          <kbd className="rounded-[1px] border border-line px-1 text-[9.5px] text-faint">Ctrl+B</kbd>
        </button>
      )}

      <span className="ml-auto min-w-0 truncate text-xs text-faint" title={label}>
        {label}
      </span>

      <span className="flex shrink-0 items-center gap-2.5 border-l border-line pl-3 text-[10.5px] text-faint">
        {status && (
          <span className="relative inline-flex min-w-[3.2em] items-center">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={status}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.14, ease: EASE }}
                className={
                  status === 'online'
                    ? 'text-accent'
                    : status === 'offline'
                      ? 'text-err'
                      : status === 'connecting'
                        ? 'text-warn'
                        : ''
                }
              >
                {STATUS_TEXT[status]}
              </motion.span>
            </AnimatePresence>
          </span>
        )}
        {renderMode && <span title="xterm 渲染后端">{renderMode}</span>}
        <span title="终端列 × 行">
          {cols} × {rows}
        </span>
        {!fontOk && (
          <span
            className="text-warn"
            title="未检测到 Sarasa Term SC Nerd，中文会回退到比例字体，字宽对不齐"
          >
            字体缺失
          </span>
        )}
      </span>
    </header>
  )
}
