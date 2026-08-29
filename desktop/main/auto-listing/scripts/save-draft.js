// ═══════════════════════════════════════════════════════════════
// auto-listing/scripts/save-draft.js — 保存草稿状态轮询脚本
// 对位：原 engine._save_draft 内嵌 JS（L654-672），PRD 14.5 验收点
//   「保存成功判定必须经过页面状态轮询，避免虚假完成」：
//   错误集{必填,不能为空,保存失败,请输入,请上传,校验不通过} →
//   {kind:'error'}；成功集{保存成功,草稿保存成功} → {kind:'success'}；
//   均未命中 → null（引擎层继续轮询，另叠加「URL 离开 create」判定）。
// ═══════════════════════════════════════════════════════════════
'use strict'

const ERROR_TEXTS = ['必填', '不能为空', '保存失败', '请输入', '请上传', '校验不通过']
const SUCCESS_TEXTS = ['保存成功', '草稿保存成功']

function saveDraftPollScript() {
  return `(() => {
    const errorTexts = ${JSON.stringify(ERROR_TEXTS)};
    const successTexts = ${JSON.stringify(SUCCESS_TEXTS)};
    const messages = Array.from(document.querySelectorAll(
      '.ant-message-notice, .arco-message, .arco-toast, ' +
      '.ant-notification-notice, .ant-form-item-explain-error'
    ));
    for (const m of messages) {
      const t = (m.textContent || '').trim();
      if (errorTexts.some((e) => t.includes(e))) return { kind: 'error', text: t };
    }
    for (const m of messages) {
      const t = (m.textContent || '').trim();
      if (successTexts.some((s) => t.includes(s))) return { kind: 'success' };
    }
    return null;
  })()`
}

module.exports = { saveDraftPollScript, ERROR_TEXTS, SUCCESS_TEXTS }
