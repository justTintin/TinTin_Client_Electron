// 临时核对脚本：UTF-8 输出原版 montage 视图层全部 UI 文案（用完即删）
const fs = require('fs');
const dir = 'D:/Project/TinTin_AI_Agent_Main/studio/gui/montage/';
for (const f of ['step2_concat_view.py', 'step3_voice_view.py', 'step4_final_view.py']) {
  const lines = fs.readFileSync(dir + f, 'utf8').split(/\r?\n/);
  console.log('════════ ' + f + ' ════════');
  lines.forEach((l, i) => {
    if (/mdi_button\(|QLabel\("|addItem\("|setPlaceholderText\(|setToolTip\("|addItems\(/.test(l)) {
      console.log((i + 1) + ': ' + l.trim());
    }
  });
}
