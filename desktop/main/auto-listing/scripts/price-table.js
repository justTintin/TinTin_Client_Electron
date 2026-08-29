// ═══════════════════════════════════════════════════════════════
// auto-listing/scripts/price-table.js — 价格库存表标记脚本
// 对位：原 engine._fill_price_table 内嵌 JS（L562-597）：
//   遍历 tr，首 td 文本归一化（normalizeText）与 SKU 名含/全等匹配 →
//   行内可见 input 依次标记 data-als-price / data-als-inv，placeholder 含
//   「编码/erp」的标记 data-als-code；引擎层填 999/999/商家编码。
// ═══════════════════════════════════════════════════════════════
'use strict'

const { normalizeText, INLINE_VISIBLE } = require('./common')

function markPriceRowScript(skuName) {
  return `(() => {
    const val = ${JSON.stringify(String(skuName))};
    const norm = (s) => (s || '').toString()
      .replace(/\\s+/g, '')
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/[－—–]/g, '-');
    const target = norm(val);
    const rows = Array.from(document.querySelectorAll('tr'));
    for (const row of rows) {
      const tds = Array.from(row.querySelectorAll('td'));
      if (tds.length < 3) continue;
      const first = norm(tds[0].textContent || '');
      if (!first || !(first === target || first.includes(target) || target.includes(first))) continue;
      ${INLINE_VISIBLE}
      const inputs = Array.from(row.querySelectorAll('input')).filter((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && el.getBoundingClientRect().width > 0;
      });
      if (inputs[0]) inputs[0].setAttribute('data-als-price', '1');
      if (inputs[1]) inputs[1].setAttribute('data-als-inv', '1');
      const code = inputs.find((inp) => (inp.placeholder || '').includes('编码') || (inp.placeholder || '').includes('erp'));
      if (code) code.setAttribute('data-als-code', '1');
      return inputs.length > 0;
    }
    return false;
  })()`
}

/** 清除价格表三个标记（对位原 L610-618） */
function clearPriceMarksScript() {
  return `(() => {
    document.querySelectorAll('[data-als-price],[data-als-inv],[data-als-code]').forEach((el) => {
      el.removeAttribute('data-als-price');
      el.removeAttribute('data-als-inv');
      el.removeAttribute('data-als-code');
    });
    return true;
  })()`
}

module.exports = { markPriceRowScript, clearPriceMarksScript, normalizeText }
