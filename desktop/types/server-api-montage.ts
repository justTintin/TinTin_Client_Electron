// ═══════════════════════════════════════════════════════════════
// server-api-montage.ts — MontageAPI 命名空间（M6/M8 条目⑥⑦）
// 自 server-api.ts 原样迁出（IRON-02 行数守恒拆分：server-api.ts 超 800 行红线），
// 类型内容零改动；server-api.ts 以 `export { MontageAPI } from './server-api-montage'`
// 原位 re-export，既有消费方（global.d.ts / api/tintin-client.ts）引用路径不变。
// ═══════════════════════════════════════════════════════════════

export namespace MontageAPI {
  // M6/M8 条目⑥⑦：montage 域类型全面对齐 API-GUIDE（禁止臆造）。
  // 文件字段渲染层只传本地路径字符串，主进程 multipartUpload 包 {path} 读盘上传。

  /** POST /montage/split（Body_split_video_montage_split_post：file/material_id/clip_url 三选一） */
  export interface SplitRequest {
    file?:            { path: string } | Blob
    material_id?:     string
    clip_url?:        string
    threshold?:       number   // 1-100 越小越敏感，默认 27
    min_scene_len?:   number   // 最小镜头秒，默认 0.5
    dedup?:           boolean
    dedup_threshold?: number
    product_mode?:    boolean
    analyze?:         boolean  // 逐镜分析（美学评分+景别/产品识别），默认 true
    image_duration?:  number   // 图片转静态镜头秒，默认 3
  }
  export type SplitResponse = {
    shots?: Array<{
      start_sec?: number; end_sec?: number; shot_index?: number; filename?: string
      download_url?: string; aesthetic_score?: number; shot_analysis?: string; description?: string
    }>
    [extra: string]: unknown
  }

  /** POST /montage/concat（Body_montage_concat_montage_concat_post，multipart：
      files[] 与 clip_urls(JSON 数组字符串，对照原版 L87 json.dumps) 至少一项） */
  export interface ConcatRequest {
    files?:               Array<{ path: string }>
    clip_urls?:           string
    transition?:          string
    transition_duration?: number
    width?:               number
    height?:              number
    fps?:                 number
    crf?:                 number
    preset?:              string
    image_duration?:      number
    /** 出入场镜头加速倍率（对齐 PR#3 edge_speedup_combo：1.0/1.2/1.5/2.0/2.5/3.0） */
    edge_speedup?:        number
  }
  export type ConcatResponse = { id?: string; task_id?: string; [extra: string]: unknown }

  /** POST /montage/bgm（Body_montage_add_bgm_montage_bgm_post：file+bgm 必填，音量可选） */
  export interface BgmRequest {
    file?:          { path: string } | Blob
    video_url?:     string
    bgm?:           { path: string } | Blob
    bgm_url?:       string
    audio_id?:      number
    bgm_volume?:    number   // 默认 0.6
    source_volume?: number   // 默认 1.0
  }
  export type BgmResponse = { ok?: boolean; path?: string; video_url?: string; [extra: string]: unknown }

  /** POST /prompt/video（Body_video_prompt_prompt_video_post：时间窗随提交，无本地裁切） */
  export interface PromptVideoRequest {
    file?:        { path: string } | Blob
    material_id?: number
    local_path?:  string
    file_ref?:    string
    start_sec?:   number
    end_sec?:     number
  }
  export type PromptVideoResponse = { task_id?: string; poll?: unknown; [extra: string]: unknown }
}
