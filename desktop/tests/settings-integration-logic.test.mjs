// ═══════════════════════════════════════════════════════════════
// settings-integration-logic.test.mjs — S8 平台接入 + S9 系统与运行编组单测
// 对照原客户端（以原代码为准）：
//   · S8 数字人 Tab main_window_pages.py L990-1245：backend_selector
//     （全部/ComfyUI/RunningHub）+ 工作流选择；服务端接口以 openapi-latest.json
//     为准：PUT /comfyui/config（ComfyUIConfig host/port 默认 127.0.0.1:8188）、
//     GET /comfyui/status；PUT /runninghub/config（api_key/base_url/...）、
//     GET /runninghub/status；数字人 /digital-human/batch（workflow_id 默认
//     2085292185062297602，无独立配置接口）
//   · S9 LUT 配置 L2041-2120：name → path 映射（.cube/.3dl/.lut）；
//     缓存目录 L1973-2039（local_config.cache_dir）；系统信息 L1622-1637
// 运行：cd desktop && node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const S = await import('../renderer/src/composables/settingsIntegrationLogic.ts')

// ── S8 平台 Tab / 默认值 ──

test('PLATFORM_TABS：数字人/ComfyUI/RunningHub 三平台（对齐原版 backend 语义）', () => {
  assert.deepEqual([...S.PLATFORM_TABS], ['数字人', 'ComfyUI', 'RunningHub'])
})

test('COMFYUI_DEFAULTS：host 127.0.0.1 / port 8188（openapi ComfyUIConfig schema）', () => {
  assert.equal(S.COMFYUI_DEFAULTS.host, '127.0.0.1')
  assert.equal(S.COMFYUI_DEFAULTS.port, 8188)
})

// ── 凭据脱敏 ──

test('maskKey：空值不脱敏；常规值掩码保留尾 4 位', () => {
  assert.equal(S.maskKey(''), '')
  assert.equal(S.maskKey('abcd'), '••••')
  assert.equal(S.maskKey('abcdefgh'), '••••efgh')
})

// ── ComfyUI 校验 / 提交体 ──

test('validateComfyui：host 必填、端口 1~65535 整数', () => {
  assert.equal(S.validateComfyui('', 8188), '请填写 ComfyUI 地址（host）')
  assert.equal(S.validateComfyui('127.0.0.1', 0), '端口应为 1~65535 的整数')
  assert.equal(S.validateComfyui('127.0.0.1', 70000), '端口应为 1~65535 的整数')
  assert.equal(S.validateComfyui('127.0.0.1', 8188), '')
})

test('buildComfyuiBody：空字段跳过、非空携带（服务端保留原值语义）', () => {
  assert.deepEqual(S.buildComfyuiBody('', 8188), { port: 8188 })
  assert.deepEqual(S.buildComfyuiBody('127.0.0.1', 0), { host: '127.0.0.1' })
  assert.deepEqual(S.buildComfyuiBody('127.0.0.1', 8188), { host: '127.0.0.1', port: 8188 })
})

// ── RunningHub 校验 / 提交体 ──

test('validateRunninghub：base_url 格式校验；api_key 缺省合法（服务端持有）', () => {
  assert.equal(S.validateRunninghub('', ''), '')
  assert.equal(S.validateRunninghub('', 'ftp://x'), 'base_url 应为 http(s)://host[:port]')
  assert.equal(S.validateRunninghub('short', ''), 'api_key 长度不应少于 8 位')
  assert.equal(S.validateRunninghub('rh_abcdef123456', 'https://www.runninghub.cn'), '')
})

test('buildRunninghubBody：空 api_key 跳过（保留已存值）、布尔开关显式携带', () => {
  assert.deepEqual(S.buildRunninghubBody('', 'https://x', true), { base_url: 'https://x', use_personal_queue: true })
  assert.deepEqual(S.buildRunninghubBody('key12345678', '', false), { api_key: 'key12345678', use_personal_queue: false })
})

// ── 平台状态响应判定 ──

test('parsePlatformStatus：离线 null=fail；{error}=fail；对象存在=可达', () => {
  assert.equal(S.parsePlatformStatus(null, 'ComfyUI').ok, false)
  assert.equal(S.parsePlatformStatus(undefined, 'RunningHub').ok, false)
  assert.equal(S.parsePlatformStatus({ error: 'boom' }, 'ComfyUI').ok, false)
  assert.equal(S.parsePlatformStatus({ online: true }, 'ComfyUI').ok, true)
  assert.equal(S.parsePlatformStatus({}, 'RunningHub').ok, true)
})

// ── S9 缓存目录 / LUT ──

test('CACHE_DIR_KEY：local.cacheDir（对齐原 local_config.cache_dir 语义）', () => {
  assert.equal(S.CACHE_DIR_KEY, 'local.cacheDir')
})

test('LUT_EXTS：.cube / .3dl / .lut（对齐原 L2048）', () => {
  assert.deepEqual([...S.LUT_EXTS], ['.cube', '.3dl', '.lut'])
})

test('normalizeLutName：去扩展名（对齐原 _add_lut_entry L2099）', () => {
  assert.equal(S.normalizeLutName('S-Log3.cube'), 'S-Log3')
  assert.equal(S.normalizeLutName('D:\\lut\\D-Log.3dl'), 'D-Log')
  assert.equal(S.normalizeLutName('noext'), 'noext')
})

test('validateLutName：空名拦截', () => {
  assert.equal(S.validateLutName(''), '请输入 LUT 显示名称')
  assert.equal(S.validateLutName('S-Log3'), '')
})

// ── S9 系统信息行 ──

test('buildSysInfoRows：os/cpu/ram/disk 四行；local=null → 未检测行', () => {
  const rows = S.buildSysInfoRows({ os: 'Windows 11', cpu: 'i7 (8 核)', ramGb: 16, disk: { freeGb: 120, totalGb: 512 } })
  assert.equal(rows.length, 4)
  assert.deepEqual(rows[0], { label: '操作系统', value: 'Windows 11' })
  assert.deepEqual(rows[1], { label: '处理器', value: 'i7 (8 核)' })
  assert.deepEqual(rows[2], { label: '内存', value: '16 GB' })
  assert.match(rows[3].value, /120 GB/)
  assert.equal(S.buildSysInfoRows(null)[0].label, '系统信息')
  assert.equal(S.buildSysInfoRows({ os: '', cpu: '', ramGb: 0, disk: null }).length, 4)
})
