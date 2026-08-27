// ═══════════════════════════════════════════════════════════════
// useFilePicker — 文件选择 + 拖拽上传 + 本地路径预览（媒体工具共享）
// 职责：openFile 对话框 / drop 拖入 / path→file:// 预览 URL；
//       选中后的组件自定义动作（清结果、抽帧等）走 onPicked 钩子
// 来源：自 media-tools 各工具的 pickFile/setFile/onDrop/resolveSrc
//       四件套重复实现收敛而来（行为不变，IRON-08）
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'

export interface FileDialogFilter {
  name: string
  extensions: string[]
}

export interface UseFilePickerOptions {
  /** 对话框标题，如「选择图片」 */
  dialogTitle: string
  /** 扩展名过滤 */
  filters?: FileDialogFilter[]
  /** 文件被选中后的钩子（清结果/抽帧等组件自定义动作） */
  onPicked?: (path: string) => void
}

export function useFilePicker(opts: UseFilePickerOptions) {
  const filePath = ref('')   // 本地完整路径
  const fileName = ref('')   // 用于展示的文件名
  const isDragging = ref(false)

  /** 打开选择对话框 */
  async function pickFile(): Promise<void> {
    const res = await window.tintin.dialog.openFile({
      title: opts.dialogTitle,
      filters: opts.filters,
    })
    if (res) setFile(res)
  }

  /** 设置文件并触发选中钩子 */
  function setFile(path: string): void {
    filePath.value = path
    fileName.value = path.split(/[\\/]/).pop() || path
    opts.onPicked?.(path)
  }

  /** 清空所选文件 */
  function clearFile(): void {
    filePath.value = ''
    fileName.value = ''
  }

  // ── 拖拽上传 ──
  function onDrop(e: DragEvent): void {
    isDragging.value = false
    const f = e.dataTransfer?.files?.[0]
    // Electron 在 File 对象上暴露 path 属性
    if (f && (f as File & { path?: string }).path) {
      setFile((f as File & { path: string }).path)
    }
  }
  function onDragOver(): void {
    isDragging.value = true
  }
  function onDragLeave(): void {
    isDragging.value = false
  }

  /** 本地路径转可显示 URL */
  function resolveSrc(src: string): string {
    if (!src) return ''
    if (/^(https?|blob|file|data):/i.test(src)) return src
    return `file://${src.replace(/\\/g, '/')}`
  }

  return {
    filePath,
    fileName,
    isDragging,
    pickFile,
    setFile,
    clearFile,
    onDrop,
    onDragOver,
    onDragLeave,
    resolveSrc,
  }
}
