// =====================================================================
// audit-ipc-consumers.js — IPC handler → 渲染层消费者 映射自检
//                          （IRON-10 跨模块一致性门禁 · 防「有 IPC 无 UI」悬空）
//
// 用法：  npm run audit:ipc     （已串入 npm run verify，随 pre-commit 一并执行）
//
// 背景：docs/BUSINESS_ALIGNMENT_移植业务对齐清单_2026-08-28.md §五.1 登记了
//       「有 IPC 无 UI」与「有 UI 无 IPC」双断层，整改抓手为「建立 handler→消费者
//       映射表，逐条接线或明确废弃」。本脚本就是该映射表的自动化版本：
//       主进程注册的每个 ipcMain.handle/on 通道，都必须能在 preload 桥接后，
//       于渲染层（或主进程面板 HTML）找到消费者。
//
// 判定链：
//   main/**/*.js        ipcMain.handle('ch') / ipcMain.on('ch')
//     ↓ 同行反查
//   preload/*.js        methodName: (…) => ipcRenderer.invoke('ch', …)
//                       （含 _withUploadProgress(onProgress, 'ch', p) 包装形态）
//     ↓ 方法名检索
//   renderer/src/**/*.{ts,vue,js} + renderer/browser/** + renderer/*.html
//   + main/*.html（downloads/extensions/history/settings 四个浮窗面板）
//
// 三段校验：
//   1/3 采集完整性 — 注册通道数 / 已桥接数 / 无法反查方法名的通道数
//   2/3 悬空通道 vs 基线 — 出现基线之外的新悬空通道 → FAIL（新增断层）
//   3/3 真死码 vs 基线 — preload 未暴露且 UI 亦无原始通道引用 → FAIL
//
// 基线语义：已知历史缺口锁进基线并附原因，门禁只拦新增。基线条目一旦被接线，
//           脚本给 WARN 提示可移除（不阻断）；条目对应通道被删除同样给 WARN。
//           基线只应随整改递减，不应新增。
//
// 保守偏差（有意）：方法名为 quit / list / get 等通用词时，渲染层任意同名词都会
//           被判为「已消费」。即本脚本宁可漏报也不误报——门禁定位是「拦住新增
//           断层」，不是「穷举存量缺口」；存量清理按基线列表人工推进。
// =====================================================================

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────
// 基线：已知悬空通道（2026-09-02 首次全量审计锁定，逐条附缺口归属）
//   格式：'通道名': '缺口归属 / 处置说明'
//   规则：只减不增。接线一条就删一条；新增悬空通道一律 FAIL 阻断提交。
// ─────────────────────────────────────────────────────────────────────
const BASELINE_UNWIRED = {
  // ── A2 平台内容抽取：extractors 全链路无出口（PRD_Browser_Extractors §八.1）──
  'browser:extractDOM':            'PRD_Browser_Extractors §八.1 消费端未定义（工作台卡片渲染待产品决策）',
  // ── S8 数字人 / ComfyUI / RunningHub 接入配置：handler 就绪，设置页无卡 ──
  'platform:getConfig':            'S8 平台接入配置卡未落地（BUSINESS_ALIGNMENT S8，P3）',
  'platform:saveComfyui':          'S8 同上',
  'platform:saveDigitalHuman':     'S8 同上',
  'platform:saveRunninghub':       'S8 同上',
  'platform:testComfyui':          'S8 同上',
  'platform:testRunninghub':       'S8 同上',
  // ── 环境与维护（S5）：检测矩阵已重定义，两个动作入口未接 UI ──
  'env:openLog':                   'S5 环境与维护卡缺「打开日志」入口',
  'env:restartService':            'S5 环境与维护卡缺「重启服务」入口',
  // ── 分镜脚本：即梦/联网素材仍为占位（落地文档 §七 已登记）──
  'material:stockSearch':          'OtStoryboard「即梦/联网素材」占位，落地文档 §七 待接口',
  // ── 产品文案：风格改写一步未接（落地文档 §4.3 流程末尾）──
  'llm:adjustCopywriting':         'OtProductCopywriting「风格改写」未接线（落地文档 §4.3）',
  // ── 会话素材池：服务端会话续接的后半段（W2）UI 未消费 ──
  'agent:sessions':                'W2 会话素材池 UI 未消费（agentChat 主链路已通）',
  'agent:sessionAttachments':      'W2 同上',
  // ── 任务下发 / 制品登记（W11）：依赖素材库闭环，按裁决后置 ──
  'agent:submitTask':              'W11 客户端任务下发闭环后置（依赖素材库接口）',
  'agent:registerArtifact':        'W11 同上',
  // ── 授权校验：服务端能力就绪，客户端无入口 ──
  'system:licenseVerify':          '授权校验 UI 未落地（等产品决策是否启用）',
  // ── VSR 旧提交式通道：SubtitleRemoval 只用 vsr:remove（useVsrRemoval.ts L157）──
  'vsr:submit':                    '字幕/水印去除已改走 vsr:remove 一步式，本通道无消费方，待废弃',
  // ── ffmpeg 通用能力：分段拼接暂无调用方（embedCover 已于 2026-09-03
  //    M9 直播切片最终导出真实接线，按基线只减不增规则从此处移除）──
  'ffmpeg:concatSegments':         'M9 直播切片最终导出对应能力待接线',
  // ── 媒体存储设置：下载目录/收藏夹走 browser 域，此四条为重复通道 ──
  'media:storageGetSettings':      '与 browser 域下载设置重复，待废弃或接线（择一）',
  'media:storageSaveSettings':     '同上',
  'media:storageOpenDownloadDir':  '同上',
  'media:storageSaveFavorites':    '同上',
  // ── 浏览器：Cookie 导出/状态，能力就绪但无 UI 入口 ──
  'browser:exportCookies':         'B5 Cookie 导出无 UI 入口（能力已具备）',
  'browser:getCookieStatus':       'B5 同上',
  // 注：browser:extensionInstall / extensionUninstall 由 extensions-panel.html 直接
  //     ipcRenderer.invoke 裸通道消费，不计悬空（isConsumed 的裸通道分支已覆盖）。
  // ── 分镜专用通道：useOpsStoryboard 走通用 server:get/post 绕过，属重复通道 ──
  'storyboard:listScripts':        '与 useOpsStoryboard 的通用 server.get 重复，待删或改用',
  'storyboard:saveScript':         '同上',
  // ── 应用生命周期：窗口关闭走原生，两条无 UI 触发点 ──
  'app:quit':                      '应用退出走原生窗口关闭，无 UI 触发点（可废弃）',
  'app:relaunch':                  '同上（重启走 env 域）',
};

const BASELINE_DEAD = {
  'downloads:list': 'download-manager.js 早期通道，已被 browser:downloadsSnapshot 取代，待删',
  'history:get':    'main.js L698-706 注册，preload 未暴露；历史面板走 history-panel.html，待确认删除',
};

// ─────────────────────────────────────────────────────────────────────
// 输出助手（与 verify-contract.js 同构）
// ─────────────────────────────────────────────────────────────────────
let anyFail = false;
function pass(label, detail) { console.log(`  ✅ PASS  ${label}${detail ? ' — ' + detail : ''}`); }
function fail(label, detail) { anyFail = true; console.log(`  ❌ FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
function warn(label, detail) { console.log(`  ⚠️  WARN  ${label}${detail ? ' — ' + detail : ''}`); }
function section(title)      { console.log(`\n━━━ ${title} ━━━`); }

function walk(dir, exts, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}
const readAll = (files) => files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

// ─────────────────────────────────────────────────────────────────────
// 1. 主进程注册的通道
// ─────────────────────────────────────────────────────────────────────
const registered = new Map(); // channel -> 相对路径
for (const f of walk(path.join(ROOT, 'main'), ['.js'])) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /ipcMain\.(?:handle|on)\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(src))) if (!registered.has(m[1])) registered.set(m[1], rel(f));
}

// ─────────────────────────────────────────────────────────────────────
// 2. preload 桥接：同行反查暴露的方法名
//    形态 A：  foo: (p) => ipcRenderer.invoke('ch', p)
//    形态 B：  foo: (p, onProgress) => _withUploadProgress(onProgress, 'ch', p)
//    形态 C：  ipcMain.send 型（浮窗开关）同上
// ─────────────────────────────────────────────────────────────────────
const bridged = new Map();   // channel -> Set<methodName>
const preloadFiles = walk(path.join(ROOT, 'preload'), ['.js']);
for (const f of preloadFiles) {
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const chRe = /['"`]([A-Za-z][\w.-]*:[\w.-]+)['"`]/g;
    let m;
    while ((m = chRe.exec(line))) {
      if (!registered.has(m[1])) continue;
      const nameM = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
      if (!nameM) continue;                       // 非同行暴露形态 → 归入「无法反查」
      if (!bridged.has(m[1])) bridged.set(m[1], new Set());
      bridged.get(m[1]).add(nameM[1]);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// 3. UI 侧源码（渲染层 + 浮窗面板 HTML）
// ─────────────────────────────────────────────────────────────────────
const uiSrc = readAll([
  ...walk(path.join(ROOT, 'renderer', 'src'),     ['.ts', '.vue', '.js']),
  ...walk(path.join(ROOT, 'renderer', 'browser'), ['.ts', '.vue', '.js']),
  ...walk(path.join(ROOT, 'renderer'),            ['.html']),
]) + '\n' + readAll(walk(path.join(ROOT, 'main'), ['.html']));

const hasWord = (w) => new RegExp(`\\b${w.replace(/[$]/g, '\\$')}\\b`).test(uiSrc);
// 消费判定：preload 方法名命中，或 UI 侧直接用裸通道名命中。
//   后者必需：四个浮窗面板 HTML（downloads/extensions/history/settings）自带
//   ipcRenderer，形如 ipcRenderer.invoke('browser:extensionInstall', filePath)，
//   不经 preload 桥接，只查方法名会把它误判为悬空。
const isConsumed = (ch, methods) => uiSrc.includes(ch) || methods.some(hasWord);

// ─────────────────────────────────────────────────────────────────────
// 校验 1/3：采集完整性
// ─────────────────────────────────────────────────────────────────────
section('1/3 · 采集完整性（handler → preload 方法名 → UI 消费者）');
if (registered.size === 0) fail('主进程 ipcMain 通道采集', '一条都没扫到，请检查 main/ 目录与正则是否失配。');
else                       pass('主进程注册通道数', String(registered.size));
if (preloadFiles.length === 0) fail('preload 文件采集', '未找到 preload/*.js。');
else                           pass('preload 桥接文件数', String(preloadFiles.length));

const unmapped = [...registered.keys()].filter((ch) => !bridged.has(ch) && uiSrc.includes(ch) === false && readAll(preloadFiles).includes(ch));
pass('已反查到方法名的通道数', `${bridged.size}/${registered.size}`);
if (unmapped.length > 0) warn('preload 含该通道但非同行暴露形态（本脚本不判定）', `${unmapped.length} 条：${unmapped.join(', ')}`);

// ─────────────────────────────────────────────────────────────────────
// 校验 2/3：悬空通道 vs 基线
// ─────────────────────────────────────────────────────────────────────
section('2/3 · 悬空通道（preload 已暴露但 UI 查无消费者）vs 基线');
const unwired = [];
for (const [ch, methods] of bridged) {
  if (!isConsumed(ch, [...methods])) unwired.push({ ch, methods: [...methods] });
}
unwired.sort((a, b) => a.ch.localeCompare(b.ch));
pass('悬空通道检出数', `${unwired.length} 条（基线 ${Object.keys(BASELINE_UNWIRED).length} 条）`);

const newUnwired = unwired.filter((o) => !(o.ch in BASELINE_UNWIRED));
if (newUnwired.length > 0) {
  fail('基线外新增悬空通道', `${newUnwired.length} 条 —— 主进程/preload 已接线但渲染层无消费者：`);
  for (const o of newUnwired) {
    console.log(`            · ${o.ch}  (via ${o.methods.join('/')}  @ ${registered.get(o.ch)})`);
  }
  console.log('            处置：补 UI 消费者，或废弃该 handler；确属已知历史缺口才可加入 BASELINE_UNWIRED 并附原因。');
} else {
  pass('无基线外新增悬空通道', '新增断层已被拦住');
}

const wiredNow = Object.keys(BASELINE_UNWIRED).filter((ch) => bridged.has(ch) && !unwired.some((o) => o.ch === ch));
const goneNow  = Object.keys(BASELINE_UNWIRED).filter((ch) => !registered.has(ch));
if (wiredNow.length > 0) warn('基线条目已接线，可从 BASELINE_UNWIRED 移除', `${wiredNow.length} 条：${wiredNow.join(', ')}`);
if (goneNow.length > 0)  warn('基线条目对应通道已不存在，请清理基线', `${goneNow.length} 条：${goneNow.join(', ')}`);

// ─────────────────────────────────────────────────────────────────────
// 校验 3/3：真死码（preload 未暴露 + UI 无原始通道引用）
// ─────────────────────────────────────────────────────────────────────
section('3/3 · 真死码（preload 未暴露且 UI 无引用）vs 基线');
const preloadSrc = readAll(preloadFiles);
const dead = [...registered.keys()].filter((ch) => !bridged.has(ch) && !preloadSrc.includes(ch) && !uiSrc.includes(ch));
dead.sort();
pass('真死码检出数', `${dead.length} 条（基线 ${Object.keys(BASELINE_DEAD).length} 条）`);

const newDead = dead.filter((ch) => !(ch in BASELINE_DEAD));
if (newDead.length > 0) {
  fail('基线外新增死码通道', `${newDead.length} 条 —— 注册了但 preload/UI 全无引用：`);
  for (const ch of newDead) console.log(`            · ${ch}  @ ${registered.get(ch)}`);
  console.log('            处置：删除该 handler，或补 preload 桥接 + UI 消费者。');
} else {
  pass('无基线外新增死码通道');
}
const deadGone = Object.keys(BASELINE_DEAD).filter((ch) => !dead.includes(ch));
if (deadGone.length > 0) warn('死码基线条目已消失（已删或已接线），请清理基线', deadGone.join(', '));

// ── 总结
section('总结');
if (anyFail) {
  console.log('[audit-ipc-consumers] ❌ 存在基线外的 IPC 断层，请接线或废弃后再提交（IRON-10）。');
  process.exit(1);
} else {
  console.log(`[audit-ipc-consumers] ✅ 无新增断层。存量悬空 ${unwired.length} 条 + 死码 ${dead.length} 条已锁基线，按归属逐条整改。`);
  process.exit(0);
}
