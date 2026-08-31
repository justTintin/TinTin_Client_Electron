// ═══════════════════════════════════════════════════════════════
// log-clear.test.mjs — 内置日志查看器「清空」单测（2026-08-31 用户反馈：
// 不再用外部软件打开，改为内置复制/清空）。被测：main/logger.js clearLogFile
// （名称白名单防穿越 + 写入归零文件保留）。electron 以 Module._load mock。
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// electron mock（logger.js 顶层 require('electron') 取 shell；clearLogFile 不触网）
const Module = require('node:module')
const _origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { shell: { openPath: async () => '', showItemInFolder: () => {} } }
  }
  return _origLoad.call(this, request, parent, isMain)
}

const logger = require('../main/logger.js')

let tmp = ''
let logsRoot = '' // initLogger(tmp) 后实际根为 tmp/logs（对齐运行时 userData/logs）
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tintin-logclear-'))
  logsRoot = path.join(tmp, 'logs')
  logger.initLogger(tmp)
})

test('clearLogFile：清空成功 → ok，文件保留且内容归零', () => {
  // 用当日日期文件名：清空审计行（logInfo）按天分文件写到当天的 client-YYYYMMDD.log，
  // 硬编码日期会在跨天后必挂（2026-09-01 教训）
  const d = new Date()
  const name = `client-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.log`
  fs.mkdirSync(logsRoot, { recursive: true })
  fs.writeFileSync(path.join(logsRoot, name), '[INFO] [t] hello\n', 'utf8')
  const r = logger.clearLogFile(name)
  assert.equal(r.ok, true)
  assert.equal(fs.existsSync(path.join(logsRoot, name)), true) // 文件保留
  // 清空动作本身写入一条审计日志（内容归零 + 新增一行 clear 记录）
  const after = fs.readFileSync(path.join(logsRoot, name), 'utf8')
  assert.ok(!after.includes('hello'), '原内容已清除')
  assert.ok(after.includes('log cleared by user'), '审计日志已写入')
})

test('clearLogFile：非白名单文件名（路径穿越/任意名）→ INVALID_NAME 不落盘', () => {
  fs.mkdirSync(logsRoot, { recursive: true })
  for (const bad of ['../client-20260101.log', 'client-2026.log', 'foo.log', '', 'client-20260101.log.bak']) {
    const r = logger.clearLogFile(bad)
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(bad)}`)
    assert.equal(r.error, 'INVALID_NAME')
  }
  // 穿越目标文件不应被创建
  assert.equal(fs.existsSync(path.join(logsRoot, 'client-20260101.log')), false)
})

test('clearLogFile：文件不存在 → NOT_FOUND', () => {
  const r = logger.clearLogFile('client-20260101.log')
  assert.equal(r.ok, false)
  assert.equal(r.error, 'NOT_FOUND')
})

test('clearLogFile：不影响其他日志文件', () => {
  const a = 'client-20260830.log'
  const b = 'client-20260831.log'
  fs.mkdirSync(logsRoot, { recursive: true })
  fs.writeFileSync(path.join(logsRoot, a), 'aaa', 'utf8')
  fs.writeFileSync(path.join(logsRoot, b), 'bbb', 'utf8')
  assert.equal(logger.clearLogFile(b).ok, true)
  assert.equal(fs.readFileSync(path.join(logsRoot, a), 'utf8'), 'aaa')
})
