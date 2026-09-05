// ═══════════════════════════════════════════════════════════════
// server-api-audio.ts — AudioAPI 命名空间（智能混剪 Step4 AI 生成 BGM +
// 媒体工具·音频组「音频生成」tab 一比一移植）
// 契约以原客户端实际调用为准（audio_library_client.py gen_bgm L159-175，
// 契约 description 中的中文 style/mood 枚举与原客户端实现矛盾，不采信）：
//   · POST /audio/gen/bgm — AI 生成 BGM（MusicGen-small）→ 生成即出
//     body: {prompt, style:"auto|electronic|classical|rock|jazz|ambient|lofi",
//            duration(秒)}；duration 边界矛盾待服务端确认（文档 3-60 vs 原 UI 5-120）
//     返回 {url, duration, prompt, engine, audio_id?}
//   · POST /audio/gen/sfx — AI 生成音效（AudioLDM2，gen_sfx L179-196）
//     body: {prompt, duration(秒,原 UI 1-15)}；未见于 openapi-latest.json
//   · POST /audio/bgm/upload — 上传 BGM 入库（bgm_upload L71-94，multipart file+tag/scene/mood）
//   · POST /sfx/analyze — 音效分析入库（sfx_analyze L127-147，multipart file，PANNs 自动标注）
// ═══════════════════════════════════════════════════════════════

export namespace AudioAPI {
  /** POST /audio/gen/bgm（2026-09-05 服务端 GUIDE 新口径：{style, mood?, duration}；
   *  style 'auto'=按历史评价优选，中文值对齐 /audio/bgm/tags 的 style 组；mood 对齐
   *  mood 组；openapi 为宽容 schema）。
   *  2026-09-05 最终裁决：无 prompt 字段——GUIDE 明确服务端自组 prompt（提示词工程
   *  收归服务端），客户端不传（主进程保留 prompt 兼容转发仅供智能混剪 Step4 旧口径） */
  export interface GenBgmRequest {
    style?: string
    mood?: string
    /** 生成时长（秒；本地不拦截区间透传服务端裁决） */
    duration?: number
  }
  export type GenBgmResponse = {
    url?: string
    duration?: number | string
    prompt?: string
    engine?: string
    audio_id?: number | string
    [extra: string]: unknown
  }

  /** POST /audio/library/upload（2026-09-05 服务端音频分流至独立 audio_library 表：
   *  保存音效用 multipart file + category='音效' + tags 入音频库（GUIDE：另存音频库
   *  走此端点）；/sfx/analyze 旧音效库不再入左列表） */
  export interface LibraryUploadRequest {
    filePath: string
    /** 四值枚举（配乐/音效/配音/其它）；音频库扫描/上传均落此表 */
    category?: string
    /** 空格分隔标签（可选） */
    tags?: string
  }

  /** POST /audio/gen/sfx（原客户端 gen_sfx 同口径：prompt+duration，无 style） */
  export interface GenSfxRequest {
    prompt: string
    /** 生成时长（秒，原客户端 UI 1-15 默认 3） */
    duration?: number
  }
  /** url 三候选 + name 两候选顺序与原版一致（url|audio_url|file_url；name|filename） */
  export type GenSfxResponse = {
    url?: string
    audio_url?: string
    file_url?: string
    name?: string
    filename?: string
    duration?: number | string
    [extra: string]: unknown
  }

  /** POST /audio/bgm/upload（2026-09-04 服务端契约更新：tag 字段移除，服务端固定
   *  category='配乐'（四值枚举 配乐/音效/配音/其它）；multipart 字段
   *  file + style（风格标签，候选源 GET /audio/bgm/tags）/ mood / scene / tags / share） */
  export interface BgmUploadRequest {
    filePath: string
    /** 风格标签（如 纯音乐/流行/电子，候选源 GET /audio/bgm/tags） */
    style?: string
    /** 自定义补充标签（空格或逗号分隔） */
    tags?: string
    scene?: string
    mood?: string
    /** 素材库共享目录（可选，默认 公共素材） */
    share?: string
  }
  export type BgmUploadResponse = Record<string, unknown>

  /** POST /sfx/analyze（原客户端 sfx_analyze 同口径：multipart file，PANNs 自动标注后入库） */
  export interface SfxAnalyzeRequest {
    filePath: string
  }
  export type SfxAnalyzeResponse = Record<string, unknown>

  /** 生成结果 URL 下载临时目录（本端扩展：入库上传需本地文件；ext 按 Content-Type
   *  判定，回退 defaultExt——BGM .mp3 / 音效 .wav，与原 _on_save_*_to_lib 口径一致） */
  export interface DownloadTempRequest {
    url: string
    /** 临时文件名前缀（原版 ai_bgm_/ai_sfx_） */
    prefix?: string
    defaultExt?: string
  }
  export type DownloadTempResponse = { path: string; contentType?: string } | { error: string }
}
