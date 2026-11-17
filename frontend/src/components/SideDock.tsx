import { AnimatePresence, motion } from 'motion/react'
import type { ReactNode } from 'react'

import { EASE } from '../motion'

type Props = {
  open: boolean
  onClose: () => void
  children: ReactNode
}

/**
 * 文件树 + Git 的召唤抽屉。从右侧滑入，压在舞台上，不推挤布局 ——
 * 进来看一眼就关，终端宽度不因为折叠展开跳来跳去。
 *
 * 之前它是常驻右列（330px 还带一条可拖分界），那是最像管理后台的一块。
 */
export function SideDock({ open, onClose, children }: Props) {
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          className="side-dock"
          aria-label="文件与 Git 抽屉"
          initial={{ x: 28, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 28, opacity: 0 }}
          transition={{ duration: 0.2, ease: EASE }}
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-[6px]">
            <span className="text-[10px] uppercase tracking-[0.12em] text-ghost">workspace</span>
            <span className="ml-auto text-[10px] text-faint">Ctrl+B</span>
            <button
              type="button"
              onClick={onClose}
              title="关闭抽屉"
              aria-label="关闭抽屉"
              className="flex h-[18px] w-[18px] items-center justify-center border border-transparent text-dim hover:border-line hover:bg-line-soft hover:text-fg"
            >
              ×
            </button>
          </header>
          <div className="side-dock-body">{children}</div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
