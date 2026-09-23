import type { InjectionKey, Ref } from 'vue'
import type { usePlanMontage } from '@/composables/usePlanMontage'

/** 编排实例类型（Phase2 拆分后的 usePlanMontage 返回值） */
export type PlanMontageUi = ReturnType<typeof usePlanMontage>

/** Phase 3 面板注入上下文（铁律 10 拆分；蓝图 docs/智能混剪Phase3拆分映射_2026-09-19.md §四）
 *  后续 P2-P4 按需扩展：vdLeftStyle/onSplitDown/previewAspect/fancyCustomPreviewStyle 等 */
export interface PlanMontageShellContext {
  s: PlanMontageUi
  step: Ref<number>
  /** 步骤条标签（2026-09-17 用户裁决：文案混剪自有标签，经 VdStepBar steps 属性下发） */
  steps: string[]
  go: (i: number) => void
  vdLeftStyle: import('vue').ComputedRef<{ flex: string }>
  onSplitDown: (e: MouseEvent) => void
  /** 右栏预览画幅（Shell computed，Step2/3/4 共用） */
  previewAspect: import('vue').ComputedRef<string>
}

export const planMontageShellKey: InjectionKey<PlanMontageShellContext> = Symbol('montageShell')