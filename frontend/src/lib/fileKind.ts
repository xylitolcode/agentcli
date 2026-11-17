/** 文件类型判断：只看名字，不读内容。
 *
 * 需求背景：二进制文件不该「点开、等后端读一遍、再告诉你不支持」，要在点击那一刻就拦下来。
 * 树的 FileEntry 只有 name/size/mtime，没有 binary 标记，所以前端只能按后缀做启发式；
 * 真正的 binary 判定仍由后端 /api/file 的 binary 字段兜底——启发式漏了，查看器里还会再提示一次。
 */

export function baseName(path: string): string {
  return (path.split('/').pop() || '').toLowerCase()
}

export function extOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

/** 后缀 -> 人能看懂的类型名。命中即「不能按文本预览」。 */
const BINARY_BY_EXT: Record<string, string> = {
  // 图片 / 设计稿
  png: '图片', jpg: '图片', jpeg: '图片', gif: '图片', webp: '图片', bmp: '图片',
  ico: '图片', icns: '图片', tif: '图片', tiff: '图片', avif: '图片', heic: '图片',
  heif: '图片', jxl: '图片',
  psd: '设计稿', ai: '设计稿', sketch: '设计稿', fig: '设计稿', xcf: '设计稿',
  raw: '相机原始图', cr2: '相机原始图', cr3: '相机原始图', nef: '相机原始图',
  arw: '相机原始图', dng: '相机原始图',
  // 压缩包 / 安装包
  zip: '压缩包', tar: '压缩包', gz: '压缩包', tgz: '压缩包', bz2: '压缩包',
  xz: '压缩包', zst: '压缩包', tbz: '压缩包', txz: '压缩包', '7z': '压缩包',
  rar: '压缩包', lz: '压缩包', lz4: '压缩包', lzma: '压缩包', z: '压缩包',
  br: '压缩包', cab: '压缩包', jar: '压缩包', war: '压缩包', ear: '压缩包',
  apk: '安装包', aab: '安装包', ipa: '安装包', deb: '安装包', rpm: '安装包',
  msi: '安装包', pkg: '安装包', dmg: '磁盘镜像', iso: '磁盘镜像', img: '磁盘镜像',
  wim: '磁盘镜像',
  // 文档（富二进制格式）
  pdf: 'PDF', doc: 'Word 文档', docx: 'Word 文档', xls: 'Excel 表格',
  xlsx: 'Excel 表格', ppt: 'PPT', pptx: 'PPT', odt: '文档', ods: '表格',
  odp: '演示文稿', epub: '电子书',
  // 可执行 / 目标文件
  exe: '可执行文件', dll: '动态库', so: '动态库', dylib: '动态库', pyd: '动态库',
  pyc: '字节码', pyo: '字节码', class: '字节码', o: '目标文件', obj: '目标文件',
  a: '静态库', lib: '静态库', wasm: 'WASM 模块',
  // 音视频
  mp3: '音频', wav: '音频', flac: '音频', aac: '音频', ogg: '音频', oga: '音频',
  opus: '音频', m4a: '音频', wma: '音频', aiff: '音频', mid: '音频', midi: '音频',
  amr: '音频',
  mp4: '视频', m4v: '视频', mkv: '视频', mov: '视频', avi: '视频', wmv: '视频',
  flv: '视频', webm: '视频', mpg: '视频', mpeg: '视频', '3gp': '视频',
  // 字体
  ttf: '字体', otf: '字体', woff: '字体', woff2: '字体', eot: '字体',
  // 数据 / 模型权重
  sqlite: '数据库', sqlite3: '数据库', db: '数据库', db3: '数据库', mdb: '数据库',
  pkl: '序列化数据', pickle: '序列化数据', npy: '数组数据', npz: '数组数据',
  pt: '模型权重', pth: '模型权重', ckpt: '模型权重', onnx: '模型文件',
  h5: '模型文件', hdf5: '模型文件', safetensors: '模型权重',
  parquet: '列式数据', feather: '列式数据', arrow: '列式数据', avro: '序列化数据',
  bson: '序列化数据', bin: '二进制数据', dat: '二进制数据',
}

/** 没有后缀、但一眼就是二进制的名字 */
const BINARY_BY_NAME: Record<string, string> = {
  '.ds_store': '系统元数据',
  'thumbs.db': '系统缩略图',
  'a.out': '可执行文件',
  core: '崩溃转储',
}

/** 命中返回类型名（如「图片」「压缩包」），未命中返回 null = 可以当文本预览 */
export function binaryKind(path: string): string | null {
  const name = baseName(path)
  const exact = BINARY_BY_NAME[name]
  if (exact) return exact
  return BINARY_BY_EXT[extOf(name)] ?? null
}

/** 能被文本查看器打开的（二进制已经在前端拦掉了，这里只是语义化用） */
export function isTextPreviewable(path: string): boolean {
  return binaryKind(path) === null
}

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx', 'mdown', 'mkd', 'mkdn'])

export function isMarkdownFile(path: string): boolean {
  return MARKDOWN_EXT.has(extOf(path))
}
