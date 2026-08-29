// ═══════════════════════════════════════════════════════════════
// auto-listing/scripts/main-upload.js — 主图上传标记脚本
// 对位：原 engine._upload_main_images 内嵌 JS（L250-277）：
//   可见 input[type=file] 向上 8 层冒泡，文本含「主图上传/上传主图」→ 命中；
//   冒泡中先遇「商品详情/详情图」→ 排除；兜底取第一个可见 file input。
//   命中后打 data-als-main 标记，由引擎层经 CDP DOM.setFileInputFiles 上传。
// ═══════════════════════════════════════════════════════════════
'use strict'

const { INLINE_VISIBLE } = require('./common')

function markMainUploadScript() {
  return `(() => {
    ${INLINE_VISIBLE}
    const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(__alsVisible);
    const main = inputs.find((inp) => {
      let node = inp;
      for (let i = 0; i < 8; i++) {
        node = node.parentElement;
        if (!node) break;
        const t = (node.textContent || '').trim();
        if (t.includes('主图上传') || t.includes('上传主图')) return true;
        if (t.includes('商品详情') || t.includes('详情图')) return false;
      }
      return false;
    }) || inputs[0];
    if (main) { main.setAttribute('data-als-main', '1'); return true; }
    return false;
  })()`
}

module.exports = { markMainUploadScript }
