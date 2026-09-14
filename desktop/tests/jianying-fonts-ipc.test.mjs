import test from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { scanFontFiles, matchServerFont, fontMatches } from '../main/jianying-fonts-ipc.js'

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); return p }
function touch(p, size = 100) { fs.writeFileSync(p, Buffer.alloc(size, 1)); return p }

test('scanFontFiles：fontdir+cache 递归收集；._ 垃圾过滤；同名同大小去重', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jyfont-'))
  const fontDir = mkdirp(path.join(root, 'Font'))
  const cache = mkdirp(path.join(root, 'Cache'))
  // fontdir：2 个字体 + 1 个垃圾 + 1 个非字体
  touch(path.join(fontDir, '悠然体.ttf'), 200)
  touch(path.join(fontDir, '后现代体.otf'), 300)
  touch(path.join(fontDir, '._悠然体.ttf'), 200)
  touch(path.join(fontDir, 'readme.txt'))
  // cache：子目录递归 + fontdir 同名同大小去重 + 同名不同大小保留 + 垃圾
  const sub = mkdirp(path.join(cache, 'effect', '123', 'abc'))
  touch(path.join(sub, '仓耳榜黑.ttf'), 500)
  touch(path.join(sub, '悠然体.ttf'), 200)        // 与 fontdir 同名同大小 → 去重（保留 fontdir 优先收录）
  touch(path.join(sub, '._HelloFont.ttf'), 400)
  touch(path.join(sub, 'HelloFont.ttf'), 400)
  try {
    const fonts = scanFontFiles(fontDir, cache)
    const names = fonts.map((f) => f.name)
    assert.ok(names.includes('悠然体.ttf') && names.includes('后现代体.otf') && names.includes('仓耳榜黑.ttf') && names.includes('HelloFont.ttf'))
    assert.ok(!names.some((n) => n.startsWith('._')), 'AppleDouble 垃圾应被过滤')
    assert.ok(!names.includes('readme.txt'), '非字体文件应被过滤')
    const youran = fonts.filter((f) => f.name === '悠然体.ttf')
    assert.equal(youran.length, 1, '同名同大小应去重')
    assert.equal(youran[0].source, 'fontdir', 'fontdir 优先收录')
    const cang = fonts.find((f) => f.name === '仓耳榜黑.ttf')
    assert.equal(cang.source, 'cache')
    assert.equal(cang.family, '仓耳榜黑')
    assert.ok(fonts.every((f) => f.sizeKb >= 0 && f.path && f.family))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fontMatches：filename 精确 + family 互含（fc-scan 英文家族名实测口径）', () => {
  // 2026-09-13 实测：字由奇巧.ttf → fc-scan family "HelloFont ID QiQiao"（与中文文件名对不上）
  assert.equal(fontMatches({ family: 'HelloFont ID QiQiao', filename: '字由奇巧.ttf' }, '字由奇巧', '字由奇巧.ttf'), true)
  assert.equal(fontMatches({ family: 'eryaxindahei', filename: '尔雅新大黑.ttf' }, '尔雅新大黑', '尔雅新大黑.ttf'), true)
  // 文件名不同但家族名互含
  assert.equal(fontMatches({ family: 'HelloFont ID QiQiao' }, 'QiQiao', ''), true)
  // 双双不匹配
  assert.equal(fontMatches({ family: 'Arial', filename: 'arial.ttf' }, '字由奇巧', '字由奇巧.ttf'), false)
})

test('matchServerFont：名称互含（大小写不敏感）；空名不判等', () => {
  assert.equal(matchServerFont('悠然体', '悠然体'), true)
  assert.equal(matchServerFont('HelloFont ID JiXieTi', 'JiXieTi'), true)
  assert.equal(matchServerFont('优设标题黑', '标题黑'), true)
  assert.equal(matchServerFont('MiYaHei', 'miyahei'), true)
  assert.equal(matchServerFont('悠然体', '仓耳榜黑'), false)
  assert.equal(matchServerFont('', 'anything'), false)
  assert.equal(matchServerFont('anything', ''), false)
})
