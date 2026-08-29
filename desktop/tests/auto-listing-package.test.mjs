// ═══════════════════════════════════════════════════════════════
// auto-listing-package.test.mjs — B12 自动上架：数据包 staging 单测
// 对位：原 validation.py prepare_package（L287-306）
// 覆盖：目录复制 staging、zip 解压 staging、runId=时间戳格式、
//   runs/<runId>/input 结构、非法输入抛错。
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRunId, stagingDir, preparePackage } from '../main/auto-listing/package.js'
import { ValidationError } from '../main/auto-listing/validate.js'
import { buildPackageFixture, zipFolder } from './auto-listing-utils.mjs'

function tempBase() {
  const d = mkdtempSync(join(tmpdir(), 'tintin-als-package-'))
  return { d, cleanup: () => rmSync(d, { recursive: true, force: true }) }
}

test('newRunId 时间戳格式 YYYYMMDD_HHMMSS', () => {
  const r = newRunId()
  assert.match(r, /^\d{8}_\d{6}$/)
  const r2 = newRunId(new Date(2026, 7, 29, 9, 5, 3))
  assert.equal(r2, '20260829_090503')
})

test('stagingDir 结构：<syncDir>/runs/<runId>/input（PRD 14.6）', () => {
  assert.ok(stagingDir('C:/als', '20260829_090000').replace(/\\/g, '/').endsWith('als/runs/20260829_090000/input'))
  assert.ok(stagingDir(join('x', 'y'), 'r1').endsWith(join('runs', 'r1', 'input')))
})

test('preparePackage 目录数据包 → runs/<runId>/input 完整 staging + runId', async () => {
  const { d, cleanup } = tempBase()
  try {
    const syncDir = join(d, 'auto-listing')
    const root = await buildPackageFixture(d)
    const res = await preparePackage(root, 'juyou', { syncDir })
    assert.match(res.runId, /^\d{8}_\d{6}$/)
    assert.equal(res.sourceName, '桔柚数据包')
    const staged = stagingDir(syncDir, res.runId)
    assert.ok(existsSync(join(staged, 'sku.xlsx')))
    assert.ok(existsSync(join(staged, '主图', '1.png')))
    assert.ok(existsSync(join(staged, '主图', '2.jpg')))
    assert.ok(existsSync(join(staged, '详情页', '1.png')))
    assert.ok(existsSync(join(staged, 'sku图', 'A款.png')))
    assert.equal(res.info.skus.length, 2)
    assert.equal(res.info.main_images.length, 2)
    assert.ok(res.info.working_dir.startsWith(staged))
  } finally { cleanup() }
})

test('preparePackage zip 数据包 → 解压 staging（adm-zip）', async () => {
  const { d, cleanup } = tempBase()
  try {
    const syncDir = join(d, 'auto-listing')
    const root = await buildPackageFixture(d, { name: '桔柚压缩包' })
    const zipPath = join(d, '桔柚压缩包.zip')
    zipFolder(root, zipPath)
    const res = await preparePackage(zipPath, 'juyou', { syncDir })
    const staged = stagingDir(syncDir, res.runId)
    assert.ok(existsSync(join(staged, 'sku.xlsx')))
    assert.ok(existsSync(join(staged, '主图', '1.png')))
    assert.equal(res.sourceName, '桔柚压缩包.zip')
    assert.equal(res.info.skus.length, 2)
  } finally { cleanup() }
})

test('preparePackage 指定 runId 复用（幂等 staging）', async () => {
  const { d, cleanup } = tempBase()
  try {
    const syncDir = join(d, 'auto-listing')
    const root = await buildPackageFixture(d)
    const res1 = await preparePackage(root, 'juyou', { syncDir, runId: '20260829_000000' })
    const res2 = await preparePackage(root, 'juyou', { syncDir, runId: '20260829_000000' })
    assert.equal(res1.runId, '20260829_000000')
    assert.equal(res2.runId, '20260829_000000')
    assert.ok(existsSync(join(stagingDir(syncDir, '20260829_000000'), 'sku.xlsx')))
  } finally { cleanup() }
})

test('preparePackage 输入路径不存在 / 非目录非 zip → 抛 ValidationError', async () => {
  const { d, cleanup } = tempBase()
  try {
    const syncDir = join(d, 'auto-listing')
    await assert.rejects(() => preparePackage(join(d, '不存在'), 'juyou', { syncDir }),
      (e) => e instanceof ValidationError && /输入路径不存在/.test(e.message))
    const txt = join(d, '说明.txt')
    writeFileSync(txt, 'not a package')
    await assert.rejects(() => preparePackage(txt, 'juyou', { syncDir }),
      (e) => e instanceof ValidationError && /必须是文件夹或 \.zip/.test(e.message))
    // 空目录（无 sku.xlsx）→ 解压/复制后校验失败
    const emptyDir = join(d, '桔柚空目录')
    mkdirSync(emptyDir, { recursive: true })
    await assert.rejects(() => preparePackage(emptyDir, 'juyou', { syncDir }),
      (e) => e instanceof ValidationError && /未找到 sku.xlsx/.test(e.message))
  } finally { cleanup() }
})
