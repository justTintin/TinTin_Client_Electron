// ═══════════════════════════════════════════════════════════════
// useLogViewer — 环境与维护卡·日志查看器 composable
// 对齐原客户端日志查看页（gui/main_window_pages.py L1563-1620）：
//   · 历史日志文件下拉（新→旧）+ 级别过滤 + 关键词过滤 + 只读文本区展示
//   · 内置操作（2026-08-31 用户反馈：不再用外部软件打开）：
//     「复制」＝当前查看内容写剪贴板（env:copyText）；
//     「清空」＝当前文件写入归零（文件保留，env:logClear）
// 数据源：env:logList / env:logRead（主进程 %APPDATA%/logs/client-YYYYMMDD.log）；
// 过滤编组纯函数在 logViewLogic.ts（可单测）。
// ═══════════════════════════════════════════════════════════════

import { computed, ref } from 'vue'
import { getTintin } from './useSettingsConfig'
import { LOG_LEVEL_FILTERS, filterLogLines } from './logViewLogic'

/** 客户端日志文件条目（env:logList 返回，新→旧） */
export interface LogFileInfo { name: string; sizeBytes: number; mtimeMs: number }

export function useLogViewer() {
  const logFiles = ref<LogFileInfo[]>([])
  const logsDir = ref<string>('')
  const selectedLog = ref<string>('')
  const levelFilter = ref<string>(LOG_LEVEL_FILTERS[0])
  const keyword = ref<string>('')
  const content = ref<string>('')
  const truncated = ref<boolean>(false)
  const loading = ref<boolean>(false)
  const loadError = ref<string>('')
  /** 复制/清空操作结果提示（短暂展示后自动消除） */
  const actionMsg = ref<string>('')
  let actionMsgTimer: ReturnType<typeof setTimeout> | null = null

  function setActionMsg(text: string) {
    actionMsg.value = text
    if (actionMsgTimer) clearTimeout(actionMsgTimer)
    actionMsgTimer = setTimeout(() => { actionMsg.value = '' }, 2500)
  }

  /** 过滤后的日志行（级别 + 关键词，纯函数编组） */
  const filteredLines = computed<string[]>(() =>
    filterLogLines(content.value ? content.value.split('\n') : [], levelFilter.value, keyword.value),
  )

  /** 拉取客户端日志文件列表（主进程 %APPDATA%/logs，新→旧）；默认选中最新一份 */
  async function loadLogList(): Promise<void> {
    const t = getTintin()
    if (!t?.env?.logList) return
    try {
      const r = await t.env.logList()
      if (r?.ok) {
        logFiles.value = r.files || []
        logsDir.value = r.dir || ''
        if (!selectedLog.value && logFiles.value.length) {
          await selectLogFile(logFiles.value[0].name)
        }
      }
    } catch (_) { /* 无 IPC / 离线静默 */ }
  }

  /** 读取选中日志文件内容（env:logRead；超 2MB 主进程读尾部并标记截断） */
  async function selectLogFile(name: string): Promise<void> {
    selectedLog.value = String(name || '')
    actionMsg.value = '' // 切换文件后旧操作提示已过时
    if (!selectedLog.value) { content.value = ''; return }
    const t = getTintin()
    if (!t?.env?.logRead) { content.value = ''; loadError.value = '预览环境：无 IPC'; return }
    loading.value = true
    loadError.value = ''
    try {
      const r = await t.env.logRead(selectedLog.value)
      if (r?.ok) { content.value = String(r.content || ''); truncated.value = !!r.truncated }
      else { content.value = ''; loadError.value = String(r?.error || '读取失败') }
    } catch (e) {
      content.value = ''
      loadError.value = String((e as any)?.message || e)
    } finally { loading.value = false }
  }

  /** 复制当前查看内容到剪贴板（所见即所复制：优先过滤后行，空则原文） */
  async function copyLog(): Promise<void> {
    const t = getTintin()
    if (!t?.env?.copyText) { setActionMsg('预览环境：无 IPC'); return }
    const text = filteredLines.value.length
      ? filteredLines.value.join('\n')
      : content.value
    try {
      const r = await t.env.copyText(text)
      setActionMsg(r?.ok ? '已复制到剪贴板' : `复制失败：${r?.error || '未知错误'}`)
    } catch (e) {
      setActionMsg(`复制失败：${String((e as any)?.message || e)}`)
    }
  }

  /** 清空当前日志文件内容（文件保留；env:logClear 主进程白名单校验） */
  async function clearLog(): Promise<void> {
    if (!selectedLog.value) return
    const t = getTintin()
    if (!t?.env?.logClear) { setActionMsg('预览环境：无 IPC'); return }
    try {
      const r = await t.env.logClear(selectedLog.value)
      if (r?.ok) {
        content.value = ''
        truncated.value = false
        setActionMsg(`已清空 ${selectedLog.value}`)
        // 列表内文件大小已过期 → 静默刷新（不重置选中/内容已归零）
        await loadLogList()
      } else {
        setActionMsg(`清空失败：${r?.error || '未知错误'}`)
      }
    } catch (e) {
      setActionMsg(`清空失败：${String((e as any)?.message || e)}`)
    }
  }

  return {
    logFiles,
    logsDir,
    selectedLog,
    levelFilter,
    keyword,
    content,
    truncated,
    loading,
    loadError,
    actionMsg,
    filteredLines,
    loadLogList,
    selectLogFile,
    copyLog,
    clearLog,
  }
}
