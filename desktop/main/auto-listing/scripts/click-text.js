// ═══════════════════════════════════════════════════════════════
// auto-listing/scripts/click-text.js — 文本点击注入脚本
// 对位：原 engine._click_text 内嵌 JS（L196-231）：
//   span/div/label/a/button/[role=button] 可见性过滤 → 文本含/全等匹配
//   ≤60 字符 → scrollIntoView + click；JS 未命中由引擎层 get_by_text 兜底。
// ═══════════════════════════════════════════════════════════════
'use strict'

const { INLINE_VISIBLE } = require('./common')

/**
 * 文本点击脚本（IIFE，返回是否命中并点击）。
 * @param {string} text 目标文本
 * @param {boolean} [exact] 全等匹配（默认包含）
 */
function clickTextScript(text, exact) {
  return `(() => {
    const text = ${JSON.stringify(String(text))};
    const exact = ${exact ? 'true' : 'false'};
    ${INLINE_VISIBLE}
    const els = Array.from(document.querySelectorAll('span,div,label,a,button,[role="button"]'));
    for (const el of els) {
      if (!__alsVisible(el)) continue;
      const t = (el.textContent || '').trim();
      const hit = exact ? t === text : t.includes(text);
      if (!hit || !t) continue;
      if (t.length > 60) continue;
      try { el.scrollIntoView({block: 'center'}); } catch (e) {}
      el.click();
      return true;
    }
    return false;
  })()`
}

module.exports = { clickTextScript }
