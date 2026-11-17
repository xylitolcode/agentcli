import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'

import type { RenderMode } from '../types'

/** 汉字宽度严格是西文的 2 倍，正好落在终端的 2-cell 网格上。
 *  放在第一位才有效：xterm 用这里第一个字体的字符宽度算 cell。 */
export const FONT_FAMILY =
  '"Sarasa Term SC Nerd","Sarasa Term SC","JetBrains Mono","Fira Code",' +
  '"Cascadia Mono","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",' +
  'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'

export const FONT_SIZE = 14

const THEME = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor: '#58a6ff',
  cursorAccent: '#0d1117',
  selectionBackground: '#264f78',
  black: '#161b22',
  red: '#f85149',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ff7b72',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
}

export type TerminalBundle = {
  term: Terminal
  fit: () => void
  renderMode: RenderMode
  dispose: () => void
}

/**
 * 建终端：WebGL 优先，不可用就退回 DOM。
 *
 * WebGL 的字形走 canvas texture atlas，高 DPI 下笔画更锐利、几万行输出不掉帧。
 * 但上下文会丢（切显卡、系统休眠），丢了不接住就是一块黑砖，所以必须挂
 * onContextLoss 让它自己退场。
 *
 * forceDom 是排查用的后门：canvas 内容截不到图，比对渲染差异时走 `?render=dom`。
 */
export function createTerminal(host: HTMLElement, options?: { forceDom?: boolean }): TerminalBundle {
  const term = new Terminal({
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    lineHeight: 1.34,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 8000,
    allowProposedApi: true,
    theme: THEME,
  })

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(host)

  let renderMode: RenderMode = 'dom'
  if (!options?.forceDom) {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
      renderMode = 'webgl'
    } catch (err) {
      console.warn('WebGL 渲染不可用，退回 DOM 渲染：', err)
    }
  }

  const fit = () => {
    try {
      fitAddon.fit()
    } catch {
      /* 容器还没有尺寸，下一帧再说 */
    }
  }

  return { term, fit, renderMode, dispose: () => term.dispose() }
}

/** 探客户端是否真的装了某字体：拿一个必然不存在的字族当基准比宽度。
 *  没命中时汉字会 fallback 到比例字体，宽度对不齐 2-cell 网格，看着就"瘦"。 */
export function isFontInstalled(family: string): boolean {
  const probe = '__agentcli_missing_font__'
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return false
  ctx.font = `32px "${probe}"`
  const base = ctx.measureText('中A').width
  ctx.font = `32px "${family}","${probe}"`
  return Math.abs(ctx.measureText('中A').width - base) > 0.5
}
