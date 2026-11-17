import { useReducedMotion } from 'motion/react'
import { lazy, Suspense, useMemo } from 'react'

const StageCore3D = lazy(() => import('./StageCore3D'))

/**
 * 3D 只在「这台机器确实扛得住」时上场：
 * WebGL2 拿不到上下文、或核数少得像台老笔记本，就退回 CSS 静图。
 * 3D 属于气氛，缺了不影响用。
 */
function canRun3D() {
  if (typeof document === 'undefined') return false
  try {
    const probe = document.createElement('canvas')
    if (!probe.getContext('webgl2')) return false
    return (navigator.hardwareConcurrency ?? 4) >= 4
  } catch {
    return false
  }
}

/**
 * 空态 = 开机。没有会话时舞台中央是一颗缓慢呼吸的神经核心，
 * 不是一行「请点上面的按钮」的灰字。
 *
 * 三条纪律：单 canvas；系统开了「减少动画」就换成静态同心圆；
 * 一开面板整个卸载，WebGL 上下文还给浏览器。
 */
export function StageCore() {
  const reduce = useReducedMotion()
  const capable = useMemo(canRun3D, [])
  const live = capable && !reduce

  return (
    <div className="stage-core">
      <div className="core-halo" aria-hidden />
      {live && (
        <Suspense fallback={null}>
          <StageCore3D />
        </Suspense>
      )}
      {!live && (
        <div className="core-static" aria-hidden>
          <i />
          <i />
          <i />
          <b />
        </div>
      )}
      <p className="core-hint">没有打开的会话 · 左侧 rail 点一个 agent 直接开</p>
    </div>
  )
}
