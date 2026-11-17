type Props = {
  onDrag: (clientX: number) => void
  onDragEnd: () => void
}

/** 一根 7px 的拖拽条。宽度计算留给父组件 —— 它才知道面板该占多少。 */
export function Splitter({ onDrag, onDragEnd }: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="splitter"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        document.body.classList.add('dragging')
      }}
      onPointerMove={(event) => {
        if (!document.body.classList.contains('dragging')) return
        onDrag(event.clientX)
      }}
      onPointerUp={() => {
        document.body.classList.remove('dragging')
        onDragEnd()
      }}
      onPointerCancel={() => {
        document.body.classList.remove('dragging')
        onDragEnd()
      }}
    />
  )
}
