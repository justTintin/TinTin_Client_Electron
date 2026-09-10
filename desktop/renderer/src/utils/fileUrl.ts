/**
 * 本地文件路径 → file:/// URL（三斜杠 + 逐段 percent 编码，盘符冒号保留）。
 *
 * 2026-09-10 定案：media:// 自定义协议链路（基于「dev 页面禁止 file://」假设引入）
 * 已回退——该假设被实测推翻（用户打包版 file:// 页面本不受限），且协议链路从未经
 * 打包版实测，风险大于收益；file:/// 三斜杠是 9 日包实测可播的已知良好状态
 * （WHATWG 对 file://X:/ 与 file:///X:/ 规范化等价，但三斜杠语义明确不依赖隐式行为）。
 */
export function toFileUrl(p: string): string {
  if (!p) return ''
  if (/^(https?|blob|data|file):/i.test(p)) return p
  const normalized = p.replace(/\\/g, '/')
  const encoded = normalized
    .split('/')
    .filter((seg) => seg !== '')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':'))
    .join('/')
  return `file:///${encoded}`
}
