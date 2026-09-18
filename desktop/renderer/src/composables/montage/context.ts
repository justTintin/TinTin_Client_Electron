// ═══════════════════════════════════════════════════════════════
// montage/context.ts — 智能混剪四步编排共享设施（铁律 10 拆分，2026-09-18）
// 拆分蓝图见 docs/智能混剪拆分迁移映射_2026-09-18.md。
// 本文件当前持有模块级纯工具；共享轮询状态机与跨步 ref 挂点随 E2+ 逐步迁入。
// 纯搬迁约定：符号名与行为与原 useVideoMontage.ts 逐字一致（IRON-02）。
// ═══════════════════════════════════════════════════════════════

export const POLL_INTERVAL_MS = 3000   // 对照原版轮询周期（_query_single_rh_task L656 同口径）
export const POLL_TIMEOUT_MS = 600_000 // 10 分钟上限

export function notify(title: string, body: string): void {
  try { window.tintin?.shell?.showNotification?.(title, body) } catch (_) {}
}

/** IpcError 三态分流：null=离线 / {error}=业务与 HTTP 错误 / 正常数据 */
export function unwrapIpc<T>(res: T | null | { error: string }, label: string): T {
  if (res === null || res === undefined) {
    throw new Error(`${label}：服务端不可达（OFFLINE），请检查服务端地址与网络`)
  }
  if (typeof res === 'object' && 'error' in (res as Record<string, unknown>)) {
    throw new Error(`${label}：${String((res as Record<string, unknown>).error)}`)
  }
  return res as T
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Windows 路径拼接（渲染层无 node path；混剪缓存目录专用） */
export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((s, i) => (i === 0 ? s.replace(/[\\/]+$/, '') : s.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('\\')
}

/** 轮询通道：unified=GET /tasks/unified/{id}；scheduled=GET /scheduled/tasks/{id}（契约各自指定） */
export type PollChannel = 'unified' | 'scheduled'
