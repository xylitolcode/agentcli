/** 把字节数变成 `12K` / `3.4M` 这种。目录传 null，返回空串。 */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes}B`

  const units = ['K', 'M', 'G', 'T']
  let value = bytes
  let index = -1
  do {
    value /= 1024
    index += 1
  } while (value >= 1024 && index < units.length - 1)

  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}${units[index]}`
}

/** 往终端里塞路径前先转义，不然带空格的文件名会被拆成两个参数。 */
export function shellQuote(path: string): string {
  if (!/[\s'"$`\\!&|<>()*?;]/.test(path)) return path
  return `'${path.replace(/'/g, "'\\''")}'`
}
