// ═══════════════════════════════════════════════════════════════
// server-api-audio.ts — AudioAPI 命名空间（智能混剪 Step4 AI 生成 BGM）
// 契约以原客户端实际调用为准（audio_library_client.py gen_bgm L159-175，
// 契约 description 中的中文 style/mood 枚举与原客户端实现矛盾，不采信）：
//   · POST /audio/gen/bgm — AI 生成 BGM（MusicGen-small）→ 生成即出
//     body: {prompt, style:"auto|electronic|classical|rock|jazz|ambient|lofi",
//            duration(秒,3-60 契约文档口径)}
//     返回 {url, duration, prompt, engine, audio_id?}
// ═══════════════════════════════════════════════════════════════

export namespace AudioAPI {
  /** POST /audio/gen/bgm（原客户端 gen_bgm 同口径：prompt 必填，无 mood） */
  export interface GenBgmRequest {
    prompt: string
    style?: string
    /** 生成时长（秒，3-60，契约文档口径） */
    duration?: number
  }
  export type GenBgmResponse = {
    url?: string
    duration?: number
    prompt?: string
    engine?: string
    audio_id?: number | string
    [extra: string]: unknown
  }
}
