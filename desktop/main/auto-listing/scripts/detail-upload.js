// ═══════════════════════════════════════════════════════════════
// auto-listing/scripts/detail-upload.js — 详情图上传标记脚本
// 对位：原 engine._upload_detail_images 内嵌 JS（L418-462）：
//   ① .decorateImgEditTitle 类名（排除 Wrapper）向上 20 层冒泡找
//     input[type=file]；② 兜底：可见 file input 向上 8 层冒泡文本含
//     「商品详情/详情图」（先遇「主图」则排除）。
//   命中打 data-als-detail 标记；另导出 multiple 判定脚本（决定批量/逐张传）。
// ═══════════════════════════════════════════════════════════════
'use strict'

const { INLINE_VISIBLE } = require('./common')

function markDetailUploadScript() {
  return `(() => {
    const labels = Array.from(document.querySelectorAll('div,span,label')).filter((el) => {
      const cls = (el.className && (el.className.baseVal !== undefined ? el.className.baseVal : el.className)) || '';
      return String(cls).includes('decorateImgEditTitle') && !String(cls).includes('Wrapper');
    });
    for (const label of labels) {
      let node = label;
      for (let i = 0; i < 20; i++) {
        node = node.parentElement;
        if (!node) break;
        const input = node.querySelector('input[type="file"]');
        if (input) { input.setAttribute('data-als-detail', '1'); return true; }
      }
    }
    const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && el.getBoundingClientRect().width > 0;
    });
    for (const input of inputs) {
      let node = input;
      for (let i = 0; i < 8; i++) {
        node = node.parentElement;
        if (!node) break;
        const t = (node.textContent || '').trim();
        if (t.includes('商品详情') || t.includes('详情图')) {
          input.setAttribute('data-als-detail', '1');
          return true;
        }
        if (t.includes('主图')) break;
      }
    }
    return false;
  })()`
}

/** 详情图上传控件是否 multiple（决定批量一次传 vs 逐张传，对位原 L469） */
function detailInputMultipleScript() {
  return `(() => {
    const el = document.querySelector('[data-als-detail="1"]');
    return el ? !!el.multiple : false;
  })()`
}

module.exports = { markDetailUploadScript, detailInputMultipleScript }
