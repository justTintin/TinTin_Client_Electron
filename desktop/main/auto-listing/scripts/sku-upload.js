// ═══════════════════════════════════════════════════════════════
// auto-listing/scripts/sku-upload.js — SKU 图上传标记脚本
// 对位：原 engine._fill_price_inventory 内嵌 JS（L517-542）：
//   按 input.value 精确匹配规格名 → 向上 8 层冒泡找
//   input[type=file], .ant-upload input[type=file] → 打 data-als-sku-upload
//   标记，引擎层经 CDP DOM.setFileInputFiles 逐 SKU 上传。
// ═══════════════════════════════════════════════════════════════
'use strict'

const { INLINE_VISIBLE } = require('./common')

function markSkuUploadScript(skuName) {
  return `(() => {
    const val = ${JSON.stringify(String(skuName))};
    ${INLINE_VISIBLE}
    const input = Array.from(document.querySelectorAll('input')).find((el) => {
      return __alsVisible(el) && (el.value || '').trim() === val;
    });
    if (!input) return false;
    let node = input;
    for (let i = 0; i < 8; i++) {
      node = node.parentElement;
      if (!node) break;
      const upload = node.querySelector('input[type="file"], .ant-upload input[type="file"]');
      if (upload) { upload.setAttribute('data-als-sku-upload', '1'); return true; }
    }
    return false;
  })()`
}

module.exports = { markSkuUploadScript }
