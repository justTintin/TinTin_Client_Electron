// ═══════════════════════════════════════════════════════════════
// auto-listing-validate.test.mjs — B12 自动上架：数据包校验单测
// 对位：原 validation.py（normalize_name / shop_matches / inspect_package）
// 覆盖：xlsx 两 sheet 解析、店铺不匹配抛错、主图非 1:1 抛错、缺图抛错、
//   缺 sku.xlsx 抛错、SKU 解析去重、缺标题 warning / 缺品牌默认无品牌。
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalizeName, shopMatches, inspectPackage, readExcel, ValidationError, PackageInfo,
} from '../main/auto-listing/validate.js'
import { buildPackageFixture, pngBytes, writeSkuXlsx } from './auto-listing-utils.mjs'

function tempBase() {
  const d = mkdtempSync(join(tmpdir(), 'tintin-als-validate-'))
  return { d, cleanup: () => rmSync(d, { recursive: true, force: true }) }
}

// ── normalizeName / shopMatches（对位原 L44-58）──
test('normalizeName 仅保留中文/字母/数字并小写', () => {
  assert.equal(normalizeName('桔柚-数据包 (Test) 001'), '桔柚数据包test001')
  assert.equal(normalizeName('  ABC 123 '), 'abc123')
  assert.equal(normalizeName(''), '')
})

test('shopMatches 命中店铺名/别名，跨店铺不匹配', () => {
  assert.equal(shopMatches('桔柚数据包.zip', 'juyou'), true)   // 别名「桔柚」
  assert.equal(shopMatches('桔柚数码外设严选-20260801', 'juyou'), true) // 店名
  assert.equal(shopMatches('555电池包', '555_battery'), true)  // 别名「555」
  assert.equal(shopMatches('555井韵电池店铺数据包', '555_battery'), true) // 店名
  assert.equal(shopMatches('555电池包', 'juyou'), false)       // 跨店铺
  assert.equal(shopMatches('通用数据包', 'juyou'), false)       // 无关命名
  assert.equal(shopMatches('任何包', 'unknown_key'), false)     // 未知店铺键
})

// ── readExcel：两 sheet 解析（对位原 _read_excel L117-208）──
test('readExcel 解析 sheet1 规格行 + sheet2 字段值（kv 优先）', async () => {
  const { d, cleanup } = tempBase()
  try {
    const xls = join(d, 'sku.xlsx')
    await writeSkuXlsx(xls)
    const r = await readExcel(d)
    assert.equal(r.title, '桔柚电池测试标题')   // sheet2 B1
    assert.equal(r.brand, '桔柚')               // sheet1 首行品牌
    assert.equal(r.model, 'X100')               // sheet2 kv 优先于 sheet1 列
    assert.equal(r.manufacturer, '测试厂')
    assert.equal(r.skus.length, 2)
    assert.equal(r.skus[0].name, 'A款')
    assert.equal(r.skus[0].merchant_code, 'P001')
    assert.equal(r.skus[1].name, 'B款')
    assert.equal(r.skus[1].merchant_code, 'P002')
  } finally { cleanup() }
})

test('readExcel SKU 名去重（重复行不重复入列）', async () => {
  const { d, cleanup } = tempBase()
  try {
    const xls = join(d, 'sku.xlsx')
    const ExcelJS = (await import('exceljs')).default
    const book = new ExcelJS.Workbook()
    const s1 = book.addWorksheet('Sheet1')
    s1.addRow(['sku图片名', '品牌'])
    s1.addRow(['重复款', '桔柚'])
    s1.addRow(['重复款', ''])
    const s2 = book.addWorksheet('Sheet2')
    s2.addRow(['标题', '去重测试'])
    await book.xlsx.writeFile(xls)
    const r = await readExcel(d)
    assert.equal(r.skus.length, 1)
    assert.equal(r.skus[0].name, '重复款')
  } finally { cleanup() }
})

// ── inspectPackage 全量校验（对位原 L221-284）──
test('inspectPackage 校验通过 → PackageInfo 等价结构', async () => {
  const { d, cleanup } = tempBase()
  try {
    const root = await buildPackageFixture(d)
    const info = await inspectPackage(root, '桔柚数据包', 'juyou')
    assert.ok(info instanceof PackageInfo)
    assert.equal(info.shop_name, '桔柚数码外设严选')
    assert.equal(info.shop_key, 'juyou')
    assert.equal(info.title, '桔柚电池测试标题')
    assert.equal(info.brand, '桔柚')
    assert.equal(info.main_images.length, 2)       // 1.png + 2.jpg 按序号排序
    assert.equal(info.detail_images.length, 1)
    assert.equal(info.sku_images.length, 2)
    assert.equal(info.skus.length, 2)
    assert.equal(info.warnings.length, 0)
    assert.equal(info.source_name, '桔柚数据包')
  } finally { cleanup() }
})

test('inspectPackage 店铺不匹配 → 抛 ValidationError（含期望关键词）', async () => {
  const { d, cleanup } = tempBase()
  try {
    const root = await buildPackageFixture(d)
    await assert.rejects(
      () => inspectPackage(root, '555电池包', 'juyou'),
      (e) => e instanceof ValidationError && /未包含目标店铺关键词/.test(e.message),
    )
  } finally { cleanup() }
})

test('inspectPackage 主图非 1:1 → 抛 ValidationError', async () => {
  const { d, cleanup } = tempBase()
  try {
    const root = await buildPackageFixture(d, { mainW: 10, mainH: 20 })
    await assert.rejects(
      () => inspectPackage(root, '桔柚数据包', 'juyou'),
      (e) => e instanceof ValidationError && /主图必须为 1:1/.test(e.message),
    )
  } finally { cleanup() }
})

test('inspectPackage 缺图片目录 → 抛 ValidationError（列出缺失项）', async () => {
  const { d, cleanup } = tempBase()
  try {
    const root = await buildPackageFixture(d, { skipSkuImages: true })
    await assert.rejects(
      () => inspectPackage(root, '桔柚数据包', 'juyou'),
      (e) => e instanceof ValidationError && /缺少可上传图片目录：sku图/.test(e.message),
    )
  } finally { cleanup() }
})

test('inspectPackage 缺 sku.xlsx → 抛 ValidationError', async () => {
  const { d, cleanup } = tempBase()
  try {
    const empty = join(d, '桔柚空包')
    mkdirSync(join(empty, '主图'), { recursive: true })
    writeFileSync(join(empty, '主图', '1.png'), pngBytes(10, 10))
    await assert.rejects(
      () => inspectPackage(empty, '桔柚空包', 'juyou'),
      (e) => e instanceof ValidationError && /未找到 sku.xlsx/.test(e.message),
    )
  } finally { cleanup() }
})

test('inspectPackage 缺标题 → warning；缺品牌 → 默认无品牌', async () => {
  const { d, cleanup } = tempBase()
  try {
    const root = join(d, '桔柚无标题包')
    mkdirSync(join(root, '主图'), { recursive: true })
    mkdirSync(join(root, '详情页'), { recursive: true })
    mkdirSync(join(root, 'sku图'), { recursive: true })
    writeFileSync(join(root, '主图', '1.png'), pngBytes(10, 10))
    writeFileSync(join(root, '详情页', '1.png'), pngBytes(10, 10))
    writeFileSync(join(root, 'sku图', 'A款.png'), pngBytes(10, 10))
    // sheet2 无标题（B1/B2 均空）→ title 保持空；品牌列留空
    const ExcelJS = (await import('exceljs')).default
    const book = new ExcelJS.Workbook()
    const s1 = book.addWorksheet('Sheet1')
    s1.addRow(['sku图片名', '品牌'])
    s1.addRow(['A款', ''])
    const s2 = book.addWorksheet('Sheet2')
    s2.addRow(['字段', ''])
    s2.addRow(['备注', ''])
    await book.xlsx.writeFile(join(root, 'sku.xlsx'))
    const info = await inspectPackage(root, '桔柚无标题包', 'juyou')
    assert.equal(info.title, '')
    assert.equal(info.brand, '无品牌')
    assert.ok(info.warnings.some((w) => /未解析到商品标题/.test(w)))
  } finally { cleanup() }
})
