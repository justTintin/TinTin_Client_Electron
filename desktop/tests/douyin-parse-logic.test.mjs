// ══════════════════════════════════════════════════════════════
// douyin-parse-logic.test.mjs — 抖音分享链接解析·纯函数单测
// （2026-09-02 用户要求：chrom-douyin-v2025.4.7 扩展预装并可用其下载。
//   该扩展为 Chrome popup 型（无 content script），Electron 无工具栏无法
//   触发 popup；其核心能力 = 提取 v.douyin.com 短链 → 调 dy.xs25.cn 解析
//   API → 无水印直链。本模块把该能力整合进客户端：纯函数提取/校验 +
//   主进程 IPC，UI 在浏览器右栏提供分享链接解析下载）
// 运行：node --test "tests/*.test.mjs"
// ══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'

const M = await import('../main/douyin-parse-logic.js')

// ── extractDouyinShareUrl：从分享文本提取 v.douyin.com 短链 ──

test('extractDouyinShareUrl：标准分享文本（中文 + 短链）', () => {
  const text = '9.99 复制打开抖音，看看【鱼白的作品】鱼白探访二次元主播周兔叽的家！ https://v.douyin.com/iRNBho6/ '
  assert.equal(M.extractDouyinShareUrl(text), 'https://v.douyin.com/iRNBho6/')
})

test('extractDouyinShareUrl：纯短链、无尾斜杠、含参数', () => {
  assert.equal(M.extractDouyinShareUrl('https://v.douyin.com/iRNBho6/'), 'https://v.douyin.com/iRNBho6/')
  assert.equal(M.extractDouyinShareUrl('https://v.douyin.com/iRNBho6'), 'https://v.douyin.com/iRNBho6')
})

test('extractDouyinShareUrl：非抖音链接 / 空值返回 null', () => {
  assert.equal(M.extractDouyinShareUrl('https://www.bilibili.com/video/BV1xx411c7mD'), null)
  assert.equal(M.extractDouyinShareUrl('随便一段文字'), null)
  assert.equal(M.extractDouyinShareUrl(''), null)
  assert.equal(M.extractDouyinShareUrl(null), null)
})

// ── validateDouyinParseResponse：dy.xs25.cn 响应校验 ──

test('validateDouyinParseResponse：code=200 且字段齐全 → ok，抽取直链与作者信息', () => {
  const resp = {
    code: 200,
    data: {
      video_url: 'https://v26-web.douyinvod.com/xxx/video/tos/cn/oAAA/?a=6383',
      additional_data: [{ nickname: '鱼白', signature: '旅行博主', desc: '探访主播的家！' }],
    },
  }
  const r = M.validateDouyinParseResponse(resp)
  assert.equal(r.ok, true)
  assert.equal(r.videoUrl, resp.data.video_url)
  assert.equal(r.author, '鱼白')
  assert.equal(r.desc, '探访主播的家！')
})

test('validateDouyinParseResponse：code!=200 → 透出服务端 msg', () => {
  const r = M.validateDouyinParseResponse({ code: 500, msg: '解析失败：无法解析视频ID' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /无法解析视频ID/)
})

test('validateDouyinParseResponse：缺 video_url / 异常结构 fail-closed', () => {
  assert.equal(M.validateDouyinParseResponse({ code: 200, data: { additional_data: [] } }).ok, false)
  assert.equal(M.validateDouyinParseResponse(null).ok, false)
  assert.equal(M.validateDouyinParseResponse('x').ok, false)
})

test('validateDouyinParseResponse：additional_data 缺失不阻塞（作者信息可空）', () => {
  const r = M.validateDouyinParseResponse({ code: 200, data: { video_url: 'https://x/a.mp4' } })
  assert.equal(r.ok, true)
  assert.equal(r.videoUrl, 'https://x/a.mp4')
  assert.equal(r.author, '')
})

// ── extractDouyinVideoIdFromUrl / buildDouyinVideoPageUrl：yt-dlp 直连主链路 ──
// （2026-09-02 用户反馈：第三方解析 API 后端被抖音风控卡死——官方文档自己的
//   示例短链都返回 500「无法解析视频信息」。实测 yt-dlp 原生支持 v.douyin.com
//   短链与视频页 URL，仅缺新鲜 cookie；客户端抖音隔离 session 有真实 cookie，
//   经 --cookies 传 yt-dlp 即可。主链路改为：短链 302 → video_id → 视频页 →
//   yt-dlp 直连；API 降为兜底）

test('extractDouyinVideoIdFromUrl：视频页 / note 页 / 302 分享页三种形态', () => {
  assert.equal(M.extractDouyinVideoIdFromUrl('https://www.douyin.com/video/7442621913643420965'), '7442621913643420965')
  assert.equal(M.extractDouyinVideoIdFromUrl('https://www.douyin.com/note/7442621913643420965'), '7442621913643420965')
  assert.equal(
    M.extractDouyinVideoIdFromUrl('https://www.iesdouyin.com/share/video/7442621913643420965/?region=CN&mid=7442622360278436634&u_code=x'),
    '7442621913643420965'
  )
})

test('extractDouyinVideoIdFromUrl：用户主页（视频已删）与无效输入 → null', () => {
  assert.equal(M.extractDouyinVideoIdFromUrl('https://www.iesdouyin.com/share/user/MS4wLjABAAAAxxxx?u_code=1'), null)
  assert.equal(M.extractDouyinVideoIdFromUrl('https://v.douyin.com/iRNBho6/'), null)
  assert.equal(M.extractDouyinVideoIdFromUrl(''), null)
  assert.equal(M.extractDouyinVideoIdFromUrl(null), null)
})

test('buildDouyinVideoPageUrl：有 id → www.douyin.com 视频页；无 id → null', () => {
  assert.equal(M.buildDouyinVideoPageUrl('7442621913643420965'), 'https://www.douyin.com/video/7442621913643420965')
  assert.equal(M.buildDouyinVideoPageUrl(''), null)
  assert.equal(M.buildDouyinVideoPageUrl(null), null)
})
