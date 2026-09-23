import type { InjectionKey, Ref } from 'vue'
import type { useCopywritingMontage } from '@/composables/useCopywritingMontage'

/** 编排实例类型（Phase2 拆分后的 useCopywritingMontage 返回值） */
export type CopywritingMontageUi = ReturnType<typeof useCopywritingMontage>

/** Phase 3 面板注入上下文（铁律 10 拆分；蓝图 docs/智能混剪Phase3拆分映射_2026-09-19.md §四）
 *  后续 P2-P4 按需扩展：vdLeftStyle/onSplitDown/previewAspect/fancyCustomPreviewStyle 等 */
export interface CopywritingMontageShellContext {
  s: CopywritingMontageUi
  step: Ref<number>
  /** 步骤条标签（2026-09-17 用户裁决：文案混剪自有标签，经 VdStepBar steps 属性下发） */
  steps: string[]
  go: (i: number) => void
  vdLeftStyle: import('vue').ComputedRef<{ flex: string }>
  onSplitDown: (e: MouseEvent) => void
  /** 右栏预览画幅（Shell computed，Step2/3/4 共用） */
  previewAspect: import('vue').ComputedRef<string>
}

export const copywritingMontageShellKey: InjectionKey<CopywritingMontageShellContext> = Symbol('montageShell')