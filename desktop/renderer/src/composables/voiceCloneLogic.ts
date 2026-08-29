// ═══════════════════════════════════════════════════════════════
// voiceCloneLogic — 声音克隆 分句/校验/合并/LLM 提示词（纯函数，无 vue/IPC 依赖）
// 业务对齐 M3（条目④）：对照原客户端 studio/gui/voice_clone_page.py：
//   · _split_text_into_sentences L860-874（本地规则拆句）
//   · _count_chars L876-879（有效字数：中文+字母数字，Python str.isalnum 口径）
//   · _estimate_max_chars L886-912（样本语速 → 单行字数上限，clamp 10~120；_SAFE_DUR_SEC=15）
//   · _merge_short_fragments L914-958（贪心合并 + 残片清理 + 末尾残片并入前句）
//   · _validate_llm_split L960-974（漏字 <99% → 本地拆分兜底）
//   · PunctuationLLMWorker prompt L49 / SentenceSplitterLLMWorker prompt L68-78
//     （代码围栏剥离 L51-52 / L80-82）
// 另收 transcription_page._show_rewrite_dialog 的洗稿消息构造 L630-642
// ═══════════════════════════════════════════════════════════════

/** PunctuationLLMWorker 系统提示词（对照 voice_clone_page.py L49 原文） */
export const PUNCTUATION_SYSTEM_PROMPT =
  '你是一个智能语音识别文本后处理助手。你的任务是给一段没有标点符号的语音识别文本添加合理的标点符号（，。！？：等），并进行合理的断句，使阅读更清晰自然。请绝对不要修改、增加或删除原文本的任何字词（只允许增删标点符号），直接输出加上标点后的纯文本，不要有任何多余的解释或包裹标记。'

/** SentenceSplitterLLMWorker 系统提示词（对照 voice_clone_page.py L68-78 原文） */
export const SENTENCE_SPLIT_SYSTEM_PROMPT =
  '你是一个短视频文案拆句专家。请把输入的文本段落拆分成适合逐句进行克隆配音合成的句子列表。\n' +
  '规则：\n' +
  '1. 第一原则是【句意完整】与【长度合理】。每一行必须是一个语义完整、能独立朗读的句子，长度一般在 10~40 字之间为宜。\n' +
  '2. 主要依据句号（。）、感叹号（！）、问号（？）以及换行进行拆分。\n' +
  '3. 【严禁拆得过碎】：绝对不要把一个连贯句子的半句、短促词、或仅 5~8 个字的残片单独拆成一行。宁可让某一行偏长一点，也不要为了多分行而把句子拆碎。\n' +
  '4. 只有当一个句子【确实过长】（明显超过 50 字、一口气无法顺畅朗读）时，才允许在自然的逗号、分号等停顿处切分；30 字并不是硬性上限，短一点或长一点都没关系，关键看是否通顺完整。\n' +
  '5. 输出格式：每行一句话，每行行首不要自己添加行号或序号（不要写 1. 2. 3. 这种）。\n' +
  '6. 【绝对忠实原文】：必须严格保持原文的每一个字，绝对不能漏字、改字、删字。特别强调——原文里【本来就有】的编号、序号、序数词（如“（一）”“（二）”“第一条”“其一”等）属于正文内容，必须原样保留在对应句子中，绝不允许删除或简化。\n' +
  '7. 只做合理的断句换行，不要对原文做任何总结、改写或润色。'

/** 单行预估时长安全上限（秒）：VoxCPM 安全区 15~17s，不超 20s（对照 _SAFE_DUR_SEC L886） */
export const SAFE_DURATION_SEC = 15.0
/** 兜底语速：拿不到样本时按 4 字/秒（中文播音常见，对照 _FALLBACK_CHARS_PER_SEC L887） */
export const FALLBACK_CHARS_PER_SEC = 4.0

/** 统计有效字数：中文+字母数字，忽略标点/空白（对照 _count_chars L876-879，isalnum 口径） */
export function countChars(s: string): number {
  const matches = String(s || '').match(/[\p{L}\p{N}]/gu)
  return matches ? matches.length : 0
}

/** 本地规则拆句：按中英句读+换行替换为换行后切分（对照 _split_text_into_sentences L860-874） */
export function splitTextIntoSentences(text: string): string[] {
  if (!text) return []
  const delimiters = ['。', '！', '？', '.', '!', '?', '\n']
  let temp = String(text)
  for (const d of delimiters) temp = temp.split(d).join('\n')
  return temp
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p)
}

/**
 * 按样本语速推算「单行配音文案最多多少字」不超 15 秒（对照 _estimate_max_chars L889-912）。
 * 语速 = 样本文案字数 / 样本音频时长；拿不到（时长≤0 或文案为空）退回 4字/秒×15s=60。
 * 结果 int 截断并 clamp 到 [10, 120]。
 */
export function estimateMaxChars(sampleDurationSec: number, sampleText: string): number {
  const n = countChars(sampleText)
  const dur = Number(sampleDurationSec) || 0
  if (dur > 0 && n > 0) {
    const charsPerSec = n / dur
    const maxChars = Math.floor(SAFE_DURATION_SEC * charsPerSec)
    return Math.max(10, Math.min(maxChars, 120))
  }
  return Math.floor(SAFE_DURATION_SEC * FALLBACK_CHARS_PER_SEC) // 60 字
}

/**
 * 按「单行预估时长 ≤ 安全上限」贪心合并相邻短句（对照 _merge_short_fragments L914-958）。
 * 第 1 遍：相邻两行合并后有效字数 ≤ maxChars 就并入当前行；否则下一行开新行。
 * 第 2 遍：清理过短残片（min_len = max(8, maxChars//4)），末尾过短并入前句。
 * 合并仅改变行数与文字，不影响后续逐行合成。
 */
export function mergeShortFragments(lines: string[], maxChars: number): string[] {
  if (!lines || !lines.length) return []
  const minLen = Math.max(8, Math.floor(maxChars / 4))

  // 第 1 遍：贪心向后合并
  const merged: string[] = []
  for (const raw of lines) {
    const s = String(raw || '').trim()
    if (!s) continue
    const last = merged.length ? merged[merged.length - 1] : ''
    if (last && countChars(last) + countChars(s) <= maxChars) {
      merged[merged.length - 1] = `${last} ${s}`
    } else {
      merged.push(s)
    }
  }

  // 第 2 遍：清理仍过短的残片（并入相邻行）
  if (merged.length >= 2) {
    const cleaned: string[] = []
    for (const s of merged) {
      const prev = cleaned.length ? cleaned[cleaned.length - 1] : ''
      if (prev && countChars(s) < minLen) {
        // 当前行过短：优先并入前句；前句已满则另起新行
        if (countChars(prev) + countChars(s) <= maxChars) {
          cleaned[cleaned.length - 1] = `${prev} ${s}`
        } else {
          cleaned.push(s)
        }
      } else {
        cleaned.push(s)
      }
    }
    // 末尾过短则并入前句
    if (cleaned.length >= 2 && countChars(cleaned[cleaned.length - 1]) < minLen) {
      const tail = cleaned[cleaned.length - 1]
      cleaned[cleaned.length - 2] = `${cleaned[cleaned.length - 2]} ${tail}`
      cleaned.pop()
    }
    return cleaned
  }
  return merged
}

/**
 * 校验 LLM 拆分是否忠实原文（对照 _validate_llm_split L960-974）。
 * 用有效字数容错比对（阈值 99%，只数中文+字母数字，排除标点/空白干扰）；
 * 漏字 → 返回本地规则拆分结果作为兜底；通过 → 返回 null。
 */
export function validateLlmSplit(originalText: string, llmLines: string[]): string[] | null {
  const origCount = countChars(originalText)
  const llmCount = (llmLines || []).reduce((n, line) => n + countChars(line), 0)
  if (origCount > 0 && llmCount < origCount * 0.99) {
    return splitTextIntoSentences(originalText)
  }
  return null
}

/** LLM 输出 → 行列表：剥代码围栏行、逐行去空（对照 worker 内 ``` 剥离 L51-52/L80-82） */
export function extractLlmLines(content: string): string[] {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('```'))
}

/** /llm/chat/completions 响应 → 文本（choices[0].message.content，防御解析） */
export function extractLlmContent(resp: unknown): string {
  const r = resp as { choices?: Array<{ message?: { content?: unknown } }> } | null
  const content = r?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : ''
}

/** 洗稿消息构造（对照 transcription_page._show_rewrite_dialog L630-642；temperature=0.7 由调用方传） */
export function buildRewriteMessages(
  hint: string,
  originalText: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  const system =
    '你是一个短视频文案改写专家。请根据用户提供的原文案，' +
    '生成一篇主题相同、内容相近、字数相差不大的新文案。' +
    '保持原有的口播节奏与信息密度，只做表达优化。' +
    '直接输出新文案正文，不要任何解释、编号或 markdown 包裹。'
  const req = (hint || '').trim() || '与原文主题一致，字数相近'
  const user = '原文案：\n' + originalText + '\n\n改写要求：' + req + '\n\n请输出改写后的文案。'
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
