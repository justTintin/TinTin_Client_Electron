// ═══════════════════════════════════════════════════════════════
// auto-listing/scripts/detect.js — 登录/店铺/创建页检测注入脚本
// 对位：原 engine._check_login（L120-126）/ _check_shop（L128-138）/
//   _open_create_page 判定（L151-157）。返回结构化结果供引擎层判断。
// ═══════════════════════════════════════════════════════════════
'use strict'

/** 登录检测：URL 含 login/passport，或 body 含「扫码登录」且不含「商品」 */
function loginCheckScript() {
  return `(() => {
    const url = (location.href || '').toLowerCase();
    if (url.includes('login') || url.includes('passport')) return { kind: 'login' };
    const text = (document.body && document.body.innerText) || '';
    if (text.includes('扫码登录') && !text.includes('商品')) return { kind: 'login' };
    return { kind: 'ok' };
  })()`
}

/**
 * 店铺检测：页面文本含「其它店铺名」且不含任何「目标店铺名/别名」→ wrong_shop。
 * @param {{targetNames: string[], otherNames: string[]}} opts
 */
function shopCheckScript({ targetNames, otherNames }) {
  return `(() => {
    const targetNames = ${JSON.stringify(targetNames || [])};
    const otherNames = ${JSON.stringify(otherNames || [])};
    const text = (document.body && document.body.innerText) || '';
    const hasTarget = targetNames.some((a) => a && text.includes(a));
    for (const other of otherNames) {
      if (other && text.includes(other) && !hasTarget) {
        return { kind: 'wrong_shop', other };
      }
    }
    return { kind: 'ok' };
  })()`
}

/** 创建页检测：login → 登录页；文本含创建商品/商品创建/主图上传 → create；否则 other */
function createPageCheckScript() {
  return `(() => {
    const url = (location.href || '').toLowerCase();
    if (url.includes('login') || url.includes('passport')) return { kind: 'login' };
    const text = (document.body && document.body.innerText) || '';
    if (text.includes('创建商品') || text.includes('商品创建') || text.includes('主图上传')) {
      return { kind: 'create' };
    }
    return { kind: 'other', url: location.href };
  })()`
}

module.exports = { loginCheckScript, shopCheckScript, createPageCheckScript }
