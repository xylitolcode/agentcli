import type { ConnStatus, RenderMode } from '../types'

type Props = {
  status: ConnStatus
  renderMode: RenderMode
  cols: number
  rows: number
  /** 终端字体是否真的装在客户端 */
  fontOk: boolean
}

const STATUS_TEXT: Record<ConnStatus, string> = {
  connecting: '正在建立会话…',
  online: '已连接',
  offline: '连接断开',
  ended: '会话已结束',
}

export function StatusBar({ status, renderMode, cols, rows, fontOk }: Props) {
  return (
    <footer className="flex shrink-0 items-center gap-3.5 overflow-hidden whitespace-nowrap border-t border-line bg-panel px-4 py-[5px] text-[11px] text-faint">
      <span>{STATUS_TEXT[status]}</span>
      <span className="min-w-2 flex-1" />
      <span title="xterm 渲染后端">{renderMode}</span>
      <span
        className={fontOk ? '' : 'text-warn'}
        title={fontOk ? '终端字体已命中' : '未检测到 Sarasa Term SC Nerd，中文会回退到比例字体，字宽对不齐'}
      >
        {fontOk ? 'Sarasa' : '中文未等宽'}
      </span>
      <span>
        {cols} × {rows}
      </span>
      <span className="text-ghost">
        <kbd className="rounded-[3px] border border-line bg-line-soft px-1 text-[10px]">Ctrl</kbd>+
        <kbd className="rounded-[3px] border border-line bg-line-soft px-1 text-[10px]">C</kbd> 中断 ·
        点文件把路径送进终端
      </span>
    </footer>
  )
}
