// ═══════════════════════════════════════════════════════════════
// auto-listing/scripts/spec.js — 规格名填写脚本（价格库存 Tab）
// 对位：原 engine._fill_price_inventory（L490-511）+ _create_new_spec_type
//   （L620-644）：
//   ① 统计可见 input[placeholder*="请输入型号"] 数量（不足点「添加规格」）；
//   ② 向该输入框写入规格名（原生 setter + input/change，React 受控兼容）
//      并派发 Enter；
//   ③ 添加规格类型兜底：点「请选择规格类型」输入框 → 点「创建类型」→
//      最后一个可见 input 填「型号」。
// ═══════════════════════════════════════════════════════════════
'use strict'

const { INLINE_VISIBLE } = require('./common')

/** 可见「请输入型号」规格输入框数量（纯函数化脚本，返回 count） */
function specInputCountScript() {
  return `(() => {
    ${INLINE_VISIBLE}
    return Array.from(document.querySelectorAll('input[placeholder*="请输入型号"]')).filter(__alsVisible).length;
  })()`
}

/** 向第 index 个可见规格输入框写入 name（返回是否命中；对位原 inputs.nth(i)） */
function setSpecNameScript(name, index = 0) {
  return `(() => {
    const name = ${JSON.stringify(String(name))};
    const index = ${Number(index) || 0};
    ${INLINE_VISIBLE}
    const el = Array.from(document.querySelectorAll('input[placeholder*="请输入型号"]')).filter(__alsVisible)[index];
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, name);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus();
    return true;
  })()`
}

/** 点「请选择规格类型」输入框（_create_new_spec_type 第一步） */
function clickSelectSpecTypeScript() {
  return `(() => {
    const el = Array.from(document.querySelectorAll('input')).find((inp) => (inp.placeholder || '').includes('请选择规格类型'));
    if (el) { el.click(); return true; }
    return false;
  })()`
}

/** 取最后一个可见 input 填「型号」（_create_new_spec_type 末段，对位 L631-644） */
function setLastInputValueScript(value) {
  return `(() => {
    const value = ${JSON.stringify(String(value))};
    ${INLINE_VISIBLE}
    const inputs = Array.from(document.querySelectorAll('input')).filter(__alsVisible);
    const target = inputs[inputs.length - 1];
    if (!target) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    target.blur();
    return true;
  })()`
}

module.exports = { specInputCountScript, setSpecNameScript, clickSelectSpecTypeScript, setLastInputValueScript }
