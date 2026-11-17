/**
 * 动效统一语言。
 *
 * 曲线和时长只在这里写一次：cubic-bezier(0.2, 0.9, 0.1, 1) / 150–220ms，
 * 弹簧 stiffness 260 / damping 30。组件里不再各自拍数字。
 *
 * 纪律：动效只解释「状态变化」和「空间关系」，不装饰。
 * 终端流式输出期间不要动布局 —— 那是逐字重排，和 layout 动画会打架。
 */
export const EASE: [number, number, number, number] = [0.2, 0.9, 0.1, 1]

/** HUD / 面板擦除这类低幅度位移的默认时长 */
export const DUR = 0.18

export const HUD = { duration: DUR, ease: EASE } as const

/** 焦点搬家（rail 竖条、舞台左沿）用的弹簧 */
export const SPRING = { type: 'spring', stiffness: 260, damping: 30 } as const
