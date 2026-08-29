// ═══════════════════════════════════════════════════════════════
// auto-listing/scripts/label-input.js — Label 关联输入几何评分标记脚本
// 对位：原 engine._fill_text_by_label 内嵌 JS（L348-384）：
//   label 文本精确匹配（可见 label/span/div）→ 遍历可见 input，按
//   dy*10+dx 最小分（dy∈[-20,280]，dx≤520）选最邻近输入框 → 打
//   data-als-label-input 标记（marker 随机后缀防串扰）。
// 几何评分抽为纯函数导出（单测覆盖）。
// ═══════════════════════════════════════════════════════════════
'use strict'

const { INLINE_VISIBLE } = require('./common')

/**
 * Label→输入框几何评分（纯函数）。
 * @param {{bottom:number, left:number}} lr label 矩形
 * @param {{top:number, left:number}} ir input 矩形
 * @returns {number|null} dy*10+dx 最小分；越界返回 null
 */
function labelGeometryScore(lr, ir) {
  const dy = ir.top - lr.bottom
  const dx = Math.abs(ir.left - lr.left)
  if (dy < -20 || dy > 280) return null
  if (dx > 520) return null
  return dy * 10 + dx
}

function markLabelInputScript(label, marker) {
  return `(() => {
    const label = ${JSON.stringify(String(label))};
    const marker = ${JSON.stringify(String(marker))};
    ${INLINE_VISIBLE}
    const labels = Array.from(document.querySelectorAll('label,span,div')).filter((el) => {
      return __alsVisible(el) && (el.textContent || '').trim() === label;
    });
    const inputs = Array.from(document.querySelectorAll('input:not([disabled])')).filter(__alsVisible);
    let best = null;
    let bestScore = 1e9;
    for (const lab of labels) {
      const lr = lab.getBoundingClientRect();
      for (const input of inputs) {
        const ir = input.getBoundingClientRect();
        const dy = ir.top - lr.bottom;
        if (dy < -20 || dy > 280) continue;
        const dx = Math.abs(ir.left - lr.left);
        if (dx > 520) continue;
        const score = dy * 10 + dx;
        if (score < bestScore) { bestScore = score; best = input; }
      }
    }
    if (best) { best.setAttribute('data-als-label-input', marker); return true; }
    return false;
  })()`
}

module.exports = { labelGeometryScore, markLabelInputScript }
