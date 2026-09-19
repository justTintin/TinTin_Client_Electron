import type { InjectionKey, Ref } from 'vue'
import type { useVideoMontage } from '@/composables/useVideoMontage'

/** 编排实例类型（Phase2 拆分后的 useVideoMontage 返回值） */
export type MontageUi = ReturnType<typeof useVideoMontage>

/** Phase 3 面板注入上下文（铁律 10 拆分；蓝图 docs/智能混剪Phase3拆分映射_2026-09-19.md §四）
 *  后续 P2-P4 按需扩展：vdLeftStyle/onSplitDown/previewAspect/fancyCustomPreviewStyle 等 */
export interface MontageShellContext {
  s: MontageUi
  step: Ref<number>
  go: (i: number) => void
}

export const montageShellKey: InjectionKey<MontageShellContext> = Symbol('montageShell')