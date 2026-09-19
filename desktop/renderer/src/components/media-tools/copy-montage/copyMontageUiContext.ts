import type { InjectionKey, Ref } from 'vue'
import type { useCopyMontage } from '@/composables/useCopyMontage'

/** 编排实例类型（Phase2 拆分后的 useCopyMontage 返回值） */
export type CopyMontageUi = ReturnType<typeof useCopyMontage>

/** Phase 3 面板注入上下文（铁律 10 拆分；蓝图 docs/智能混剪Phase3拆分映射_2026-09-19.md §四）
 *  后续 P2-P4 按需扩展：vdLeftStyle/onSplitDown/previewAspect/fancyCustomPreviewStyle 等 */
export interface CopyMontageShellContext {
  s: CopyMontageUi
  step: Ref<number>
  go: (i: number) => void
  vdLeftStyle: import('vue').ComputedRef<{ flex: string }>
  onSplitDown: (e: MouseEvent) => void
  /** 右栏预览画幅（Shell computed，Step2/3/4 共用） */
  previewAspect: import('vue').ComputedRef<string>
}

export const copyMontageShellKey: InjectionKey<CopyMontageShellContext> = Symbol('montageShell')