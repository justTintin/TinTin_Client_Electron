// ═══════════════════════════════════════════════════════════════
// logViewLogic — 日志查看器编组纯函数（无 vue/IPC 依赖，可单测）
// 对齐原客户端日志查看页（gui/main_window_pages.py L1563-1620）：
//   · 历史日志文件下拉 + 级别过滤（全部/INFO/WARNING/ERROR/DEBUG）+
//     关键词过滤 + QTextEdit 只读展示
// 新端日志行格式（main/logger.js _append）：
//   `[YYYY-MM-DD HH:mm:ss.mmm] [LEVEL] [tag] message`
// 业务动作（加载/切换文件）在 useLogViewer.ts。
// ═══════════════════════════════════════════════════════════════

/** 级别过滤选项（原客户端口径：全部 + 具体级别） */
export const LOG_LEVEL_FILTERS = ['全部', 'INFO', 'WARN', 'ERROR'] as const

/** 从日志行提取级别（`[ts] [LEVEL] [tag] msg`；无级别前缀返回 ''） */
export function parseLogLevel(line: string): string {
  const m = /\]\s*\[(INFO|WARN|WARNING|ERROR|DEBUG)\]\s*/.exec(String(line || ''))
  return m ? m[1] : ''
}

/**
 * 过滤日志行（级别 + 关键词，均大小写不敏感；''/「全部」= 不过滤）。
 * @param lines 日志行数组（已按 \n 拆分）
 * @param level LOG_LEVEL_FILTERS 之一（'全部' = 不过滤；WARNING 归并 WARN）
 * @param keyword 关键词子串（'' = 不过滤）
 */
export function filterLogLines(lines: string[], level: string, keyword: string): string[] {
  const lv = String(level || '').trim()
  const kw = String(keyword || '').trim().toLowerCase()
  const needLevel = lv && lv !== '全部'
  return (lines || []).filter((line) => {
    const rowLv = parseLogLevel(line).replace('WARNING', 'WARN')
    if (needLevel && rowLv !== (lv === 'WARNING' ? 'WARN' : lv)) return false
    if (kw && !String(line).toLowerCase().includes(kw)) return false
    return true
  })
}
