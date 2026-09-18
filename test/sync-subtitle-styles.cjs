// test/sync-subtitle-styles.cjs — 客户端 24 种字幕样式预设 → 服务端字幕样式库
// 用法：
//   node test/sync-subtitle-styles.cjs              # 干跑：生成清单，不上传
//   node test/sync-subtitle-styles.cjs --upload      # 实传（幂等 upsert：同 id PUT 覆盖）
//   node test/sync-subtitle-styles.cjs --server http://IP:PORT  # 指定服务端
//
// 映射规则：客户端 drawtext 片段 → 服务端 subtitle_style JSON
//   fontcolor=0xRRGGBB  → color: "#RRGGBB"
//   borderw=N           → outline: N
//   bordercolor=0xRRGGBB → outline_colour: "#RRGGBB"
//   公共默认：pos=bottom, fontsize=0.056, margin=0.12
'use strict'
const http = require('node:http')

const SERVER = (process.argv.find((_, i, a) => a[i - 1] === '--server') || 'http://192.168.111.31:8000').replace(/\/$/, '')
const DRY_RUN = !process.argv.includes('--upload')

// ── 客户端 24 种预设（voice-tts-logic.js SUBTITLE_STYLES + videoMontageLogic.ts SUBTITLE_STYLE_PRESETS）──
const PRESETS = [
  { key: 'white',        label: '默认 白字',   color: '#FFFFFF', stroke: '' },
  { key: 'white_blk',    label: '白字黑边',    color: '#FFFFFF', stroke: '#000000' },
  { key: 'white_gray',   label: '白字灰边',    color: '#FFFFFF', stroke: '#555555' },
  { key: 'white_red',    label: '白字红边',    color: '#FFFFFF', stroke: '#CC2222' },
  { key: 'white_blue',   label: '白字蓝边',    color: '#FFFFFF', stroke: '#2266CC' },
  { key: 'black_white',  label: '黑字白边',    color: '#111111', stroke: '#FFFFFF' },
  { key: 'black_yellow', label: '黑字黄边',    color: '#111111', stroke: '#FFD700' },
  { key: 'yellow_blk',   label: '黄字黑边',    color: '#FFE135', stroke: '#000000' },
  { key: 'yellow_red',   label: '黄字红边',    color: '#FFE135', stroke: '#CC0000' },
  { key: 'gold_blk',     label: '金字黑边',    color: '#F0C040', stroke: '#3A2000' },
  { key: 'gold_red',     label: '金字红边',    color: '#F0C040', stroke: '#CC0000' },
  { key: 'orange_white', label: '橙字白边',    color: '#FF8C1A', stroke: '#FFFFFF' },
  { key: 'pink_blk',     label: '粉字黑边',    color: '#FF7EB9', stroke: '#000000' },
  { key: 'pink_white',   label: '粉字白边',    color: '#FF7EB9', stroke: '#FFFFFF' },
  { key: 'red_white',    label: '红字白边',    color: '#FF4040', stroke: '#FFFFFF' },
  { key: 'red_yellow',   label: '红字黄边',    color: '#FF4040', stroke: '#FFE135' },
  { key: 'blue_blk',     label: '蓝字黑边',    color: '#40A0FF', stroke: '#000000' },
  { key: 'blue_white',   label: '蓝字白边',    color: '#40A0FF', stroke: '#FFFFFF' },
  { key: 'sky_white',    label: '天蓝白边',    color: '#7FD4FF', stroke: '#FFFFFF' },
  { key: 'green_blk',    label: '绿字黑边',    color: '#40FF80', stroke: '#000000' },
  { key: 'green_white',  label: '绿字白边',    color: '#40FF80', stroke: '#FFFFFF' },
  { key: 'teal_white',   label: '青字白边',    color: '#2EC4B6', stroke: '#FFFFFF' },
  { key: 'purple_white', label: '紫字白边',    color: '#C060FF', stroke: '#FFFFFF' },
  { key: 'purple_blk',   label: '紫字黑边',    color: '#C060FF', stroke: '#000000' },
]

// ── 预设 → 服务端 StyleBlockIn 映射 ──
function presetToServer(p) {
  const style = {
    pos: 'bottom',
    color: p.color,
    fontsize: 0.056,   // 与历史成片字大小一致（guide 推荐值）
    margin: 0.12,      // 底边距
  }
  if (p.stroke) {
    style.outline = 3
    style.outline_colour = p.stroke
  }
  // 生成标签：按色系归类
  const tags = []
  if (p.stroke) tags.push('描边')
  const colorFamily = guessColorFamily(p.color)
  if (colorFamily) tags.push(colorFamily)
  if (!p.stroke) tags.push('无描边')
  return {
    id: p.key,
    name: p.label,
    style,
    tags,
    scenario: '通用',
  }
}

function guessColorFamily(hex) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  if (r > 200 && g > 200 && b > 200) return '白'
  if (r < 50 && g < 50 && b < 50) return '黑'
  if (r > 200 && g > 180 && b < 80) return '黄'
  if (r > 200 && g > 100 && b < 50) return '橙'
  if (r > 200 && g < 80 && b < 80) return '红'
  if (r > 200 && g > 100 && b > 150 && b < 200) return '粉'
  if (r > 150 && g > 150 && b < 50) return '金'
  if (r < 100 && g > 150 && b > 200) return '蓝'
  if (r < 100 && g > 200 && b > 100) return '绿'
  if (r < 100 && g > 150 && b > 200) return '天蓝'
  if (r < 100 && g > 180 && b > 150) return '青'
  if (r > 150 && g < 120 && b > 200) return '紫'
  return ''
}

// ── HTTP 工具 ──
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, SERVER)
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    }
    const req = http.request(opts, (res) => {
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, data }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

// ── 主流程 ──
async function main() {
  const items = PRESETS.map(presetToServer)
  console.log(`客户端预设 ${items.length} 种，映射完成：`)
  for (const it of items) {
    console.log(`  ${it.id.padEnd(16)} ${it.name.padEnd(10)} → ${JSON.stringify(it.style)}`)
  }

  if (DRY_RUN) {
    console.log('\n[干跑] 不上传。加 --upload 实传。')
    // 输出 JSON 清单供检查
    const fs = require('node:fs')
    const outPath = __dirname + '/m0-out/subtitle-styles-sync.json'
    fs.mkdirSync(__dirname + '/m0-out', { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(items, null, 2))
    console.log(`清单已写入 ${outPath}`)
    return
  }

  // 先查服务端已有
  const listRes = await request('GET', '/subtitle_styles')
  const existing = new Set((listRes.data?.styles || []).map((s) => s.id))
  console.log(`\n服务端已有 ${existing.size} 个样式：${[...existing].join(', ')}`)

  let created = 0, updated = 0, failed = 0
  for (const it of items) {
    const isUpdate = existing.has(it.id)
    const method = isUpdate ? 'PUT' : 'POST'
    const urlPath = isUpdate ? `/subtitle_styles/${it.id}` : '/subtitle_styles'
    try {
      const res = await request(method, urlPath, it)
      if (res.status >= 200 && res.status < 300) {
        if (isUpdate) { updated++; console.log(`  ✅ 更新 ${it.id}`) }
        else { created++; console.log(`  ✅ 创建 ${it.id}`) }
      } else {
        failed++
        console.log(`  ❌ ${it.id}: HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 120)}`)
      }
    } catch (err) {
      failed++
      console.log(`  ❌ ${it.id}: ${err.message}`)
    }
  }
  console.log(`\n完成：创建 ${created}，更新 ${updated}，失败 ${failed}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
