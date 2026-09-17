import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildSyncPackage, collectTemplateFonts, buildRawSyncPackage } from '../main/jianying-templates.js'

/** 构造最小 .textpreset 预设：指定 rid/示例文字/字体资源（panel=fonts，含重复与缺失项） */
function makePreset(dir, rid, fontPath) {
  const content = JSON.stringify({
    text: '你好世界',
    styles: [{ size: 60, fill: { content: { solid: { color: [1, 1, 1] } } } }],
  })
  const preset = {
    effect: { resource_id: rid, effect_name: '测试模板', category_name: '热门' },
    paragraphs: [{ content: JSON.stringify(content) }],
    resources: [
      { panel: 'fonts', file_path: fontPath },
      { panel: 'fonts', file_path: fontPath }, // 重复条目 → 去重
      { panel: 'fonts', file_path: path.join(dir, '不存在.ttf') }, // 缺失 → 过滤
    ],
  }
  fs.writeFileSync(path.join(dir, `预设_${rid}.textpreset`), JSON.stringify(preset))
}

test('collectTemplateFonts：panel=fonts 字体收集；路径去重；缺失过滤', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jytpl-font-'))
  try {
    const fontPath = path.join(dir, '测试字体.ttf')
    fs.writeFileSync(fontPath, Buffer.alloc(1024, 1))
    makePreset(dir, 't1', fontPath)
    const fonts = collectTemplateFonts(dir, 't1')
    assert.equal(fonts.length, 1, '重复与缺失应过滤，仅保留 1 个')
    assert.equal(fonts[0].name, '测试字体.ttf')
    assert.equal(fonts[0].path, fontPath)
    assert.deepEqual(collectTemplateFonts(dir, '不存在rid'), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('buildSyncPackage：fontFamily 覆盖 HTML font-family 并入 variables.font；缺省回退雅黑', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jytpl-font-'))
  try {
    const fontPath = path.join(dir, '测试字体.ttf')
    fs.writeFileSync(fontPath, Buffer.alloc(1024, 1))
    makePreset(dir, 't1', fontPath)
    const withFont = buildSyncPackage(dir, 't1', { fontFamily: '测试字体' })
    assert.ok(withFont.html.includes("font-family:'测试字体',\"Microsoft YaHei\",sans-serif"), 'font-family 应写服务端家族名并回退雅黑')
    assert.equal(withFont.meta.variables.font.default, '测试字体')
    assert.ok(withFont.fonts === undefined || Array.isArray(withFont.fonts))
    const without = buildSyncPackage(dir, 't1')
    assert.ok(without.html.includes('font-family:"Microsoft YaHei",sans-serif'), '缺省回退雅黑')
    assert.equal(without.meta.variables.font.default, 'Microsoft YaHei')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('buildRawSyncPackage：预设位置 .textpreset 源文件原样打包到 preset/<文件名>（2026-09-17 用户裁决）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jytpl-raw-'))
  try {
    const fontPath = path.join(dir, '测试字体.ttf')
    fs.writeFileSync(fontPath, Buffer.alloc(1024, 1))
    makePreset(dir, 't1', fontPath)
    const built = buildRawSyncPackage(dir, 't1', dir, { fontFamily: '测试字体' })
    assert.ok(built, '应成功构包')
    // 包内含 meta.json / template.html / preset/预设_t1.textpreset
    const names = built.files.map((f) => f.name)
    assert.ok(names.includes('meta.json'))
    assert.ok(names.includes('template.html'))
    assert.ok(names.includes('preset/预设_t1.textpreset'), '预设源文件应打包到 preset/ 下：' + names.join(','))
    // 原样拷贝（absPath 指向真实预设文件，非 Buffer data）
    const presetEntry = built.files.find((f) => f.name === 'preset/预设_t1.textpreset')
    assert.equal(presetEntry.absPath, path.join(dir, '预设_t1.textpreset'))
    assert.ok(fs.existsSync(presetEntry.absPath))
    // v2 标识保留
    assert.equal(built.meta.format_version, 2)
    assert.equal(built.meta.engine, 'runtime-v2')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

