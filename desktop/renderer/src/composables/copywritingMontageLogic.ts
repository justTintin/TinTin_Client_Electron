// ═══════════════════════════════════════════════════════════════
// copywritingMontageLogic.ts — 智能混剪·服务端四步链路纯逻辑（M8 条目⑥ parser/builder 层）
// 铁律 10（2026-09-18 智能混剪拆分事故后建立）：本文件已按步骤拆分降级为桶文件
// （兼容层），实现纯搬迁至下列子模块（过 SKILL.md IRON-02 五项 checklist，
// 符号名与行为零改动；消费方 useCopywritingMontage.ts / VideoMontage.vue / tests/*.mjs
// 经本桶继续导入无需改动，后续新代码请直连子模块）：
//   · copywritingMontageCommonLogic.ts      任务轮询状态机 + 路径工具（四步共用）
//   · copywritingMontageStep1SplitLogic.ts  Step1 素材解析/裁剪/缓存 + 素材常量与景别分类
//   · copywritingMontageStep2ConcatLogic.ts Step2 拼接载荷/预合成方案/口播文案请求
//   · copywritingMontageStep3VoiceLogic.ts  Step3 口播配音/花字样式/AI 改写
//   · copywritingMontageStep4FxBgmLogic.ts  Step4 BGM 混音与生成/特效包装/文字模板/字幕样式与重切
// 组件/composable 只做编排，纯逻辑层不做任何 IPC / DOM 操作（IRON-06/07 分层）
// ═══════════════════════════════════════════════════════════════

export * from './copywritingMontageCommonLogic.ts'
export * from './copywritingMontageStep1SplitLogic.ts'
export * from './copywritingMontageStep2ConcatLogic.ts'
export * from './copywritingMontageStep3VoiceLogic.ts'
export * from './copywritingMontageStep4FxBgmLogic.ts'
