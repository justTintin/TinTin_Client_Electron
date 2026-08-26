// ═══════════════════════════════════════════════════════════════
// ocr-local.js — A2 本地 OCR（PaddleOCR INT8 × 3 onnxruntime-node）
//
// 规格 §1.5.2：
//   - 懒加载 3 个 InferenceSession（det/rec/cls），避免冷启动阻塞 1s+
//   - 模型文件位于 app.getPath('userData')/models/onnx/
//   - 调用失败返回抛错，由 inference-router.js 负责自动 fallback（Q3 红线）
//
// 注意：模型未下载时，此模块加载成功但调用会抛错
//       （router 在 hybrid-auto 模式下会自动切 HTTP，用户零感知）
// ═══════════════════════════════════════════════════════════════

const fs = require('node:fs')
const path = require('node:path')

let _ort = null        // onnxruntime-node 懒加载
let _sessions = null   // { det, rec, cls } 懒加载
let _dict = null       // paddle_rec_dict.txt 词典行数组
let _loadError = null

function requireOrt() {
  if (_ort) return _ort
  try {
    _ort = require('onnxruntime-node')
    return _ort
  } catch (e) {
    _loadError = e
    throw new Error(`onnxruntime-node require 失败：${e.message}`)
  }
}

async function loadSessions(modelsDir) {
  if (_sessions) return _sessions
  const ort = requireOrt()
  const InferenceSession = ort.InferenceSession
  const opts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }

  const required = [
    ['paddle_det_int8.onnx', 'det'],
    ['paddle_rec_int8.onnx', 'rec'],
    ['paddle_cls_int8.onnx', 'cls'],
  ]
  const loaded = {}
  for (const [fname, key] of required) {
    const fp = path.join(modelsDir, fname)
    if (!fs.existsSync(fp)) {
      throw new Error(`OCR 模型缺失：${fname}`)
    }
    try {
      loaded[key] = await InferenceSession.create(fp, opts)
    } catch (e) {
      throw new Error(`加载 ${fname} 失败：${e.message}`)
    }
  }
  // 词典
  const dictPath = path.join(modelsDir, 'paddle_rec_dict.txt')
  if (!fs.existsSync(dictPath)) {
    throw new Error('OCR 词典缺失：paddle_rec_dict.txt')
  }
  _dict = fs.readFileSync(dictPath, 'utf-8').split(/\r?\n/).filter(Boolean)
  _sessions = loaded
  return _sessions
}

// ───────────────── 图像预处理（stub：实际生产用 sharp 或 canvas 实现）─────────────────
function imageToFloat32Buffer(imageBuffer) {
  // **占位实现**：
  // 真实实现需要：按 PaddleOCR 规范 3×H×W RGB → 归一化到 mean/std → Float32Array
  // 以及图像尺寸对齐 det 的输入 stride（64 倍数），rec 的 3×48×W
  //
  // 开发/模型未就绪阶段，这里直接抛错让 inference-router 自动 fallback HTTP
  // （符合 Q3 红线：hybrid-auto 下本地失败 → 用户零感知切服务端）
  throw new Error('[OCR-local] 预处理 stub：模型下载后此处需接入真实图像预处理实现')
}

// ───────────────── det → cls → rec 三阶段流水线（占位实现）─────────────────
async function runOcrPipeline(sessions, dict, imageBuffer, opts) {
  // **占位实现**：
  // 真实流水线：
  //   1) det = sessions.det.run({ x: preprocessedTensor }) → 输出 boxes
  //   2) 对每个 box crop 原图 → sessions.cls 判定方向（0/180）→ 必要时翻转
  //   3) sessions.rec.run({ x: croppedTensor }) → ctc greedy/beam 解码 → 对照 dict 取字符
  //
  // 占位：抛错 → router fallback HTTP
  throw new Error('[OCR-local] 推理 stub：模型下载后此处需接入 det/cls/rec 完整流水线')
}

// ───────────────── 对外：createLocalOcr（返回 { imageToText } 执行器）─────────────────
function createLocalOcr({ modelsDir }) {
  return {
    /**
     * @param {Buffer|string} input  Buffer 或绝对路径
     * @param {{ lang?: string }} opts
     * @returns {Promise<{ lines: Array<{bbox:[number,number,number,number],text:string,confidence:number}>, durationMs: number }>}
     */
    async imageToText(input, opts = {}) {
      const t0 = Date.now()
      const sessions = await loadSessions(modelsDir)
      // 读取输入
      let imgBuf
      if (typeof input === 'string') imgBuf = fs.readFileSync(input)
      else if (Buffer.isBuffer(input)) imgBuf = input
      else throw new Error('OCR input 必须是 Buffer 或文件路径')

      const lines = await runOcrPipeline(sessions, _dict, imgBuf, opts)
      return {
        lines,
        durationMs: Date.now() - t0,
      }
    },
    /** 预热：尝试懒加载会话，返回 { ok, reason? } */
    async preload() {
      try { await loadSessions(modelsDir); return { ok: true } }
      catch (e) { return { ok: false, reason: e.message } }
    }
  }
}

module.exports = { createLocalOcr }
