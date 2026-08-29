// ═══════════════════════════════════════════════════════════════
// auto-listing/scripts/common.js — B12 注入脚本共享纯函数/内联片段
// 对位：原 engine.py 内嵌 JS 中重复出现的 isVisible / norm 逻辑
//   （_click_text L199-206 / _upload_main_images L252-258 / 价格表 norm L564-569）。
// 纯函数导出供单测；页面内联片段用字符串模板注入 executeJavaScript。
// ═══════════════════════════════════════════════════════════════
'use strict'

/** 文本归一化（对位原价格表 norm：去空白、全角括号/破折号→半角） */
function normalizeText(s) {
  return (s || '').toString()
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[－—–]/g, '-')
}

/** 可见性判断内联片段（对位原 isVisible 箭头函数，双引号 JSON 拼接安全） */
const INLINE_VISIBLE = `
const __alsVisible = (el) => {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (!style || style.visibility === 'hidden' || style.display === 'none') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};`

/** 清除元素上 data-als-* 标记（对位原 evaluate 清标记段） */
function clearMarkScript(attr) {
  return `(() => {
    const el = document.querySelector('[${String(attr)}]');
    if (el) el.removeAttribute('${String(attr)}');
    return true;
  })()`
}

/** 页面是否仍在「上传中」（对位原 _wait_upload_done 的 text=上传中 判定） */
function uploadingCheckScript() {
  return `(() => {
    const text = (document.body && document.body.innerText) || '';
    return text.includes('上传中');
  })()`
}

/** 对当前聚焦元素派发 Enter（对位原 inp.press("Enter")，React 受控组件兼容） */
function pressEnterScript() {
  return `(() => {
    const el = document.activeElement;
    if (!el) return false;
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    return true;
  })()`
}

/** 对当前聚焦元素派发 Tab（对位原 inp.press("Tab") 失焦触发校验） */
function pressTabScript() {
  return `(() => {
    const el = document.activeElement;
    if (!el) return false;
    const opts = { key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    return true;
  })()`
}

/** 用原生 setter 赋 input 值并派发 input/change + focus（React 受控组件兼容，对位 Playwright fill） */
function setInputValueScript(selector, value) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus();
    return true;
  })()`
}

module.exports = { normalizeText, INLINE_VISIBLE, clearMarkScript, uploadingCheckScript, pressEnterScript, pressTabScript, setInputValueScript }
