import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildSyncPackage, collectTemplateFonts, buildV2AssetUpgrade } from '../main/jianying-templates.js'

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

test('buildV2AssetUpgrade：effectStyle 规范化 + data_val 逐字动画 + fonts patch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jyv2-'))
  try {
    const flower = path.join(dir, 'flower_res')
    const textRes = path.join(dir, 'text_res')
    fs.mkdirSync(flower, { recursive: true })
    fs.mkdirSync(textRes, { recursive: true })
    fs.writeFileSync(path.join(flower, 'effectStyle.json'), JSON.stringify({
      fill: { alpha: 1, content: { render_type: 'gradient', gradient: { angle: 90, color: [[1, 1, 1], [0.5, 0.5, 0.5]], percent: [0, 1], style: 'linear', mode: 'character' }, solid: { alpha: 1, color: [1, 1, 1] } } },
      inner_shadows: [{ alpha: 0.7, angle: 90, distance: 3, diffuse: 0.4, enable: true, content: { render_type: 'solid', solid: { alpha: 1, color: [0, 0, 0] } } }],
      shadows: [], strokes: [{ width: 2, content: { solid: { color: [1, 0, 0] } } }],
    }))
    fs.writeFileSync(path.join(textRes, 'data_val.json'), JSON.stringify({
      bezierValue2: [0.78, 0.15, 0.34, 0.95], textAnimTimer: [0.1, 1],
      single_char_anim_time: [0.08, 0.4], blur_info: [0, 0.1, 0.5, 1], initialPosition_weight: 0.1,
    }))
    const fontTtf = path.join(dir, '测试字体.ttf')
    fs.writeFileSync(fontTtf, Buffer.alloc(64, 1))
    const preset = {
      effect: { resource_id: 'v1', effect_name: 'V2测试', category_name: '热门' },
      paragraphs: [{ content: JSON.stringify({ text: '四字测试', styles: [{ size: 60 }] }) }],
      resources: [
        { panel: 'flower', file_path: flower },
        { panel: 'text', file_path: textRes },
        { panel: 'fonts', file_path: fontTtf },
      ],
    }
    fs.writeFileSync(path.join(dir, '预设_v1.textpreset'), JSON.stringify(preset))
    const serverFonts = [{ id: 'font_1', family: 'ZiYuYongHongTi', filename: '测试字体.ttf' }]
    const pkg = buildV2AssetUpgrade(dir, 'v1', path.join(dir, 'Cache'), { serverFonts })
    const pkgFiles = Object.fromEntries(pkg.files.map((f) => [f.name, String(f.data || '')]))
    assert.ok(pkgFiles['assets/effect_style.json'], 'effect_style 应在包内')
    assert.ok(pkgFiles['assets/text_anim.json'], 'text_anim 应在包内')
    const es = JSON.parse(pkgFiles['assets/effect_style.json'])
    assert.equal(es.fills[0].type, 'gradient')
    assert.equal(es.fills[0].stops[1].color, '#808080')
    assert.equal(es.shadows[0].kind, 'inner')
    assert.equal(es.shadows[0].color, '#000000')
    assert.equal(es.stroke.color, '#ff0000')
    const ta = JSON.parse(pkgFiles['assets/text_anim.json'])
    assert.equal(ta.chars.length, 4, '逐字条目=文字长度')
    assert.deepEqual(ta.chars[0].easing, [0.78, 0.15, 0.34, 0.95])
    const mp = JSON.parse(pkgFiles['meta_patch.json'])
    assert.deepEqual(mp.fonts, [{ family: 'ZiYuYongHongTi' }], 'family 对齐服务端 fc-scan 名')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
