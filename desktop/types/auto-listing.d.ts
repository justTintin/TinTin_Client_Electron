// ═══════════════════════════════════════════════════════════════
// auto-listing.d.ts — B12 自动上架：tintinBrowser.autoListing 类型
// （全局脚本声明，无 import/export；由 tsconfig include "types/**/*.d.ts"
//   加载，global.d.ts TintinBrowserBridge 直接引用本文件 interface）
// 对位：main/auto-listing/ipc.js（7 条 IPC + 订阅式 channel
//   'auto-listing:progress'，payload { runId, stage, message, ts, result? }）
// ═══════════════════════════════════════════════════════════════

/** autoListing:validate 摘要（对位 ipc.js _summary：店铺/标题/SKU/三类图数/警告） */
declare interface TintinAutoListingValidateData {
  runId: string
  title: string
  shopName: string
  shopKey: string
  skuCount: number
  skus: Array<{ name: string; merchant_code: string }>
  mainImages: number
  detailImages: number
  skuImages: number
  warnings: string[]
}

/** autoListing:listRuns 单条记录（state.json 摘要） */
declare interface TintinAutoListingRun {
  runId: string
  stage: string
  status: string
  ts?: number
  sourceName?: string
  title?: string
}

/** auto-listing:progress 订阅 payload（stage 同时作事件类型：progress 行/done/error） */
declare interface TintinAutoListingProgress {
  runId: string
  stage: 'progress' | 'done' | 'error' | string
  message: string
  ts: number
  result?: {
    saved?: boolean
    publish_attempted?: boolean
    working_dir?: string
    result_dir?: string
    sku_count?: number
    runId?: string
  }
}

declare interface TintinBrowserAutoListing {
  /** 数据包导入+校验（staging 产生 runId） */
  validate(payload: {
    inputPath: string
    shopKey?: string
    runId?: string
  }): Promise<{ success: boolean; data?: TintinAutoListingValidateData; error?: string }>
  /** 启动后台任务（互斥；传 runId 复用 validate 已 staging 的数据包） */
  start(payload: {
    inputPath?: string
    shopKey?: string
    publishAfterSave?: boolean
    runId?: string
  }): Promise<{ success: boolean; data?: { runId: string }; error?: string }>
  /** 请求停止（shouldStop → 引擎抛「任务已停止」） */
  stop(): Promise<{ success: boolean; data?: { stopped: boolean; runId?: string; reason?: string }; error?: string }>
  /** 断点续跑（读 state.json + URL 特征） */
  resume(payload: {
    runId: string
    publishAfterSave?: boolean
  }): Promise<{ success: boolean; data?: { runId: string }; error?: string }>
  /** 当前任务状态 */
  status(): Promise<{ success: boolean; data?: { running: boolean; runId?: string }; error?: string }>
  /** 历史运行列表（runs 目录全部 runId + state 摘要，新→旧） */
  listRuns(): Promise<{ success: boolean; data?: { runs: TintinAutoListingRun[] }; error?: string }>
  /** 打开 results/<runId> 目录 */
  openResultDir(runId: string): Promise<{ success: boolean; error?: string }>
  /** 订阅式进度（注册返回固定 channel 'auto-listing:progress'；返回取消订阅函数） */
  onProgress(cb: (p: TintinAutoListingProgress) => void): () => void
}
