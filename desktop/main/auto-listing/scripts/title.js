// ═══════════════════════════════════════════════════════════════
// auto-listing/scripts/title.js — 商品标题定位标记脚本
// 对位：原 engine._fill_title 内嵌 JS（L299-329）：
//   placeholder 选择器（请输入2-60/商品标题/标题）→ 未命中则 label 文本
//   全等「商品标题」向上 6 层冒泡找 input:not([disabled])。
//   命中打 data-als-title 标记，引擎层用原生 setter 填值（React 受控兼容）。
// ═══════════════════════════════════════════════════════════════
'use strict'

function markTitleScript() {
  return `(() => {
    const selectors = [
      'input[placeholder*="请输入2-60"]',
      'input[placeholder*="商品标题"]',
      'input[placeholder*="标题"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetWidth > 0) {
        el.setAttribute('data-als-title', '1');
        return true;
      }
    }
    const labels = Array.from(document.querySelectorAll('label,span,div')).filter((el) => {
      return (el.textContent || '').trim() === '商品标题' && el.getBoundingClientRect().width > 0;
    });
    for (const label of labels) {
      let node = label;
      for (let i = 0; i < 6; i++) {
        node = node.parentElement;
        if (!node) break;
        const input = node.querySelector('input:not([disabled])');
        if (input) { input.setAttribute('data-als-title', '1'); return true; }
      }
    }
    return false;
  })()`
}

module.exports = { markTitleScript }
