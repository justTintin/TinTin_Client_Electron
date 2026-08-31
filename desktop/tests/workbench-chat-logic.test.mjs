// ═══════════════════════════════════════════════════════════════
// workbench-chat-logic.test.mjs — 工作台对话·渲染层纯逻辑单测
// 被测：renderer/src/composables/workbenchChatLogic.ts（纯函数，无 vue 依赖；
// Node ≥22.18 原生 type stripping 直接加载）。
// 对照原客户端 gui/agent_home_page.py：
//   · _trim_history L1452-1456（最近 12 条且总字符 ≤8000）
//   · _ChatWorker llm 分支 L642-653（空 history 注入 _SYSTEM_PROMPT、末位 user 替换）
//   · agent_client.agent_chat L286-297（mode=plan 无 reply 含 task_id → 提示文本）
//   · _restore_chat L1682-1684（恢复时防御性过滤非法消息）
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const L = await import('../renderer/src/composables/workbenchChatLogic.ts')

test('trimHistory：保留最近 12 条（超出从头删除）', () => {
  const h = Array.from({ length: 15 }, (_, i) => ({ role: 'user', content: 'm' + i }))
  const r = L.trimHistory(h)
  assert.equal(r.length, 12)
  assert.equal(r[0].content, 'm3')
  assert.equal(r[11].content, 'm14')
})

test('trimHistory：总字符超 8000 从头截断（截到总量达标即停，原版口径）', () => {
  const h = [
    { role: 'user', content: 'x'.repeat(6000) },
    { role: 'assistant', content: 'y'.repeat(3000) },
    { role: 'user', content: '最新消息' }
  ]
  const r = L.trimHistory(h)
  assert.equal(r.length, 2)
  assert.equal(r[0].content, 'y'.repeat(3000))
  assert.equal(r[1].content, '最新消息')
})

test('trimHistory：输入不突变（返回新数组）', () => {
  const h = [{ role: 'user', content: 'a' }]
  const r = L.trimHistory(h)
  assert.notEqual(r, h)
  assert.equal(r.length, 1)
})

test('buildLlmMessages：空 history → system 提示词开头 + 本轮 user', () => {
  const msgs = L.buildLlmMessages([], '你好')
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'system')
  assert.ok(msgs[0].content.includes('运营助手'))
  assert.deepEqual(msgs[1], { role: 'user', content: '你好' })
})

test('buildLlmMessages：末位为 user（上轮失败残留）→ 替换为本轮文本', () => {
  const msgs = L.buildLlmMessages(
    [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答' }, { role: 'user', content: '上一轮未回复' }],
    '本轮问题'
  )
  assert.equal(msgs[msgs.length - 1].content, '本轮问题')
  assert.equal(msgs.length, 3)
})

test('buildLlmMessages：末位为 assistant → 追加本轮 user', () => {
  const msgs = L.buildLlmMessages(
    [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
    'q2'
  )
  assert.deepEqual(msgs[2], { role: 'user', content: 'q2' })
})

test('extractAgentReply：正常响应映射 reply/session_id', () => {
  const r = L.extractAgentReply({ reply: '答案', session_id: 's-1', attachments: [], tool_calls: [] })
  assert.deepEqual(r, { reply: '答案', sessionId: 's-1', taskId: '', isPlan: false })
})

test('extractAgentReply：mode=plan 无 reply 含 task_id → 编排提示文本', () => {
  const r = L.extractAgentReply({ reply: '', session_id: 's-2', task_id: 'a_123' }, 'plan')
  assert.equal(r.isPlan, true)
  assert.equal(r.taskId, 'a_123')
  assert.ok(r.reply.includes('a_123'))
  assert.ok(r.reply.includes('编排任务'))
})

test('extractAgentReply：空回复且无 task_id → null（触发「服务端未返回内容」）', () => {
  assert.equal(L.extractAgentReply({ reply: '', session_id: 's-3' }), null)
  assert.equal(L.extractAgentReply(null), null)
  assert.equal(L.extractAgentReply({}), null)
})

test('extractLlmReply：OpenAI 格式取 choices[0].message.content；异常 → null', () => {
  assert.equal(L.extractLlmReply({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }), 'hi')
  assert.equal(L.extractLlmReply({ choices: [] }), null)
  assert.equal(L.extractLlmReply(null), null)
})

test('sanitizeSessions：防御持久化脏数据（非数组/缺 id/非法消息/40 条截断）', () => {
  assert.deepEqual(L.sanitizeSessions(null), [])
  assert.deepEqual(L.sanitizeSessions('junk'), [])
  const raw = [
    { id: 'ok-1', title: 'T', updatedAt: 100, serverSessionId: 's-9', mode: 'agent',
      messages: [{ role: 'user', content: 'u' }, { role: 'bad', content: 'x' }, { role: 'assistant', content: '' }] },
    { title: '缺 id 不收' },
    'junk-entry'
  ]
  const r = L.sanitizeSessions(raw)
  assert.equal(r.length, 1)
  assert.equal(r[0].id, 'ok-1')
  assert.equal(r[0].serverSessionId, 's-9')
  assert.deepEqual(r[0].messages, [{ role: 'user', content: 'u' }])
  // 40 条截断（_CHAT_SAVE_ROUNDS 口径）
  const big = [{ id: 'b', messages: Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: 'm' + i })) }]
  assert.equal(L.sanitizeSessions(big)[0].messages.length, 40)
  assert.equal(L.sanitizeSessions(big)[0].messages[0].content, 'm20')
})

test('sessionGroupOf：今天/昨天/更早边界', () => {
  const now = new Date(2026, 7, 28, 12, 0, 0).getTime()
  const day = 86400000
  assert.equal(L.sessionGroupOf(now - 1000, now), 'today')
  assert.equal(L.sessionGroupOf(now - day + 3600000, now), 'yesterday')
  assert.equal(L.sessionGroupOf(now - 3 * day, now), 'earlier')
})

test('buildAttachmentText：llm 模式附件文本携带（原版 L1748-1750 口径）', () => {
  const atts = [
    { name: 'a.mp4', path: 'D:\\素材\\a.mp4', state: 'pooled' },
    { name: 'b.png', path: 'D:/素材/b.png', state: 'pending' }
  ]
  const t = L.buildAttachmentText(atts)
  assert.ok(t.startsWith('【附件】'))
  assert.ok(t.includes('- a.mp4（D:\\素材\\a.mp4）'))
  assert.ok(t.includes('- b.png（D:/素材/b.png）'))
  assert.equal(t.split('\n').length, 3)
})

test('buildAttachmentText：空/脏条目 → 空串（agent 模式不拼文本由调用方保证）', () => {
  assert.equal(L.buildAttachmentText([]), '')
  assert.equal(L.buildAttachmentText([{ name: '', path: '', state: 'pending' }]), '')
  assert.equal(L.buildAttachmentText(null), '')
})

test('basenameOf：兼容 \\ 与 / 分隔符（os.path.basename 口径）', () => {
  assert.equal(L.basenameOf('D:\\素材\\a.mp4'), 'a.mp4')
  assert.equal(L.basenameOf('D:/素材/b.png'), 'b.png')
  assert.equal(L.basenameOf('c.txt'), 'c.txt')
})

/* ── W8：回复成片视频资产识别（原 _detect_video_asset L1392-1418 三级识别） ── */

test('detectVideoAsset ①：绝对 URL 含视频特征（.mp4 / /render / /result / /video / /output / /download）', () => {
  assert.deepEqual(
    L.detectVideoAsset('成片已生成：https://cdn.example.com/videos/render_12.mp4'),
    { url: 'https://cdn.example.com/videos/render_12.mp4', taskId: '' }
  )
  assert.deepEqual(
    L.detectVideoAsset('结果 https://srv.local/render/5/result?v=1'),
    { url: 'https://srv.local/render/5/result?v=1', taskId: '' }
  )
  assert.deepEqual(
    L.detectVideoAsset('下载 https://srv.local/video/out.webm，请查收'),
    { url: 'https://srv.local/video/out.webm', taskId: '' }
  )
  // 尾部中文标点/括号去尾（原版 rstrip(".,;:!?") 口径；中文标点不进 URL）
  assert.deepEqual(
    L.detectVideoAsset('地址 https://srv.local/output/a.mp4。'),
    { url: 'https://srv.local/output/a.mp4', taskId: '' }
  )
})

test('detectVideoAsset ②：/editor/render/{id}/result 相对路径 → 拼 serverBase', () => {
  assert.deepEqual(
    L.detectVideoAsset('成片：/editor/render/42/result', 'http://192.168.1.1:8000/'),
    { url: 'http://192.168.1.1:8000/editor/render/42/result', taskId: '42' }
  )
  // 无 serverBase → 保持相对路径（下载时由主进程按 getServerUrl 解析）
  assert.deepEqual(
    L.detectVideoAsset('成片：/editor/render/7/result'),
    { url: '/editor/render/7/result', taskId: '7' }
  )
})

test('detectVideoAsset ③：成片语境 + 任务ID → render 结果端点兜底', () => {
  assert.deepEqual(
    L.detectVideoAsset('已创建编排任务：`a_88`，成片将自动生成，任务ID：#88', 'http://srv:8000'),
    { url: 'http://srv:8000/editor/render/88/result', taskId: '88' }
  )
  // task id 全角冒号
  assert.deepEqual(
    L.detectVideoAsset('渲染完成，task id：123', 'http://srv:8000'),
    { url: 'http://srv:8000/editor/render/123/result', taskId: '123' }
  )
  // 无成片语境（普通编号）→ 不兜底
  assert.equal(L.detectVideoAsset('今天任务 ID：#99 已完成，共 3 项'), null)
})

test('detectVideoAsset：无资产文本 → null（空文本 / 普通文本 / 无视频特征 URL）', () => {
  assert.equal(L.detectVideoAsset(''), null)
  assert.equal(L.detectVideoAsset('你好，有什么可以帮你？'), null)
  assert.equal(L.detectVideoAsset('参考文档 https://docs.example.com/guide'), null)
})

/* ── W9：引用回复 / 重新生成（原 _on_quote L1283-1289 / _on_regenerate L1291-1318） ── */

test('buildQuoteText：原文逐行加 "> " 前缀；空文本兜底 "> "', () => {
  assert.equal(L.buildQuoteText('第一行\n第二行'), '> 第一行\n> 第二行')
  assert.equal(L.buildQuoteText(''), '> ')
  assert.equal(L.buildQuoteText('单行'), '> 单行')
})

test('buildQuoteInsert：现有输入非空 → 引用块在上、原内容在下；空输入 → 引用块 + 换行', () => {
  assert.equal(L.buildQuoteInsert('原文', '补充指令'), '> 原文\n\n补充指令')
  assert.equal(L.buildQuoteInsert('原文', '   '), '> 原文\n')
  assert.equal(L.buildQuoteInsert('原文', ''), '> 原文\n')
})

test('regenerateHistoryTrim：删除用户提问后紧跟的旧 assistant 回复（原版 L1312-1317）', () => {
  const h = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' }
  ]
  // 回退 q2 轮 → 删除 a2，q1/a1 保留
  assert.deepEqual(L.regenerateHistoryTrim(h, 'q2'), [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' }
  ])
  // 回退 q1 轮（首个匹配）→ 删除 a1
  assert.deepEqual(L.regenerateHistoryTrim(h, 'q1'), [
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' }
  ])
  // 找不到该轮 → 原样返回（新数组，不影响重发）
  assert.deepEqual(L.regenerateHistoryTrim(h, 'q9'), h)
  // 输入不突变
  assert.notEqual(L.regenerateHistoryTrim(h, 'q2'), h)
})

/* ── W10：对话资产识别 detectChatAssets / parseMarkdownTable（右侧预览面板数据源） ── */

test('detectChatAssets：python 代码块 → script（lang=python，title=语言）', () => {
  const r = L.detectChatAssets('```python\nprint("hello")\n```')
  assert.equal(r.length, 1)
  assert.equal(r[0].type, 'script')
  assert.equal(r[0].lang, 'python')
  assert.equal(r[0].title, 'python')
  assert.ok(r[0].content.includes('print'))
  assert.ok(r[0].id.startsWith('asset-'))
})

test('detectChatAssets：无代码块长文案（>3 行）→ text（title=首行）', () => {
  const content = '方案一：标题\n\n第一段说明\n第二段说明\n第三段说明\n第四段收尾'
  const r = L.detectChatAssets(content)
  assert.equal(r.length, 1)
  assert.equal(r[0].type, 'text')
  assert.equal(r[0].title, '方案一：标题')
  assert.equal(r[0].content, content)
})

test('detectChatAssets：含标题结构的短文案 → text（title=标题文本）', () => {
  const r = L.detectChatAssets('# 分镜脚本\n镜头一：开场')
  assert.equal(r.length, 1)
  assert.equal(r[0].type, 'text')
  assert.equal(r[0].title, '分镜脚本')
})

test('detectChatAssets：markdown 表格 → table（title=表头首列）', () => {
  const t = '| 商品 | 价格 |\n| --- | --- |\n| A | 10 |\n| B | 20 |'
  const r = L.detectChatAssets(t)
  assert.equal(r.length, 1)
  assert.equal(r[0].type, 'table')
  assert.equal(r[0].title, '商品')
  assert.ok(r[0].content.includes('A'))
})

test('detectChatAssets：混合（代码块+表格+正文）→ 3 个资产顺序稳定', () => {
  const content = '思路如下：\n\n```bash\necho hi\n```\n\n| 列 | 值 |\n| --- | --- |\n| x | 1 |\n\n然后补充说明\n再补充说明\n最后补充说明'
  const r = L.detectChatAssets(content)
  assert.equal(r.length, 3)
  assert.deepEqual(r.map((a) => a.type), ['script', 'table', 'text'])
  assert.equal(r[0].lang, 'bash')
})

test('detectChatAssets：空内容 / 纯空白 → []', () => {
  assert.deepEqual(L.detectChatAssets(''), [])
  assert.deepEqual(L.detectChatAssets('   \n  '), [])
})

test('detectChatAssets：无语言标注/文档类代码块不算 script → []', () => {
  assert.deepEqual(L.detectChatAssets('```\nplain text\n```'), [])
  assert.deepEqual(L.detectChatAssets('```text\n说明文字\n```'), [])
})

test('detectChatAssets：title 超长截断 ≤30（标题/首行兜底「内容资产」）', () => {
  const long = 'x'.repeat(50)
  const r = L.detectChatAssets(`# ${long}\n正文一\n正文二\n正文三`)
  assert.equal(r[0].type, 'text')
  assert.equal(r[0].title, long.slice(0, 30))
  assert.ok(r[0].title.length <= 30)
})

test('parseMarkdownTable：剔除分隔行，返回二维数组（单元 trim）', () => {
  const rows = L.parseMarkdownTable('| 商品 | 价格 |\n| --- | --- |\n| A | 10 |')
  assert.deepEqual(rows, [['商品', '价格'], ['A', '10']])
})

// ── latestSessionOfMode：模式切换复用最近会话（2026-08-31 用户反馈：
//    来回切换对话/智能体不得不停新建空会话） ──

const mkSessions = (rows) => rows.map(([id, mode, updatedAt]) => ({
  id, mode, updatedAt, title: 'x', subtitle: '', serverSessionId: '', messages: []
}))

test('latestSessionOfMode：返回该模式 updatedAt 最大的会话', () => {
  const list = mkSessions([
    ['s1', 'llm', 100],
    ['s2', 'agent', 300],
    ['s3', 'llm', 200],
    ['s4', 'agent', 150]
  ])
  assert.equal(L.latestSessionOfMode(list, 'llm')?.id, 's3')
  assert.equal(L.latestSessionOfMode(list, 'agent')?.id, 's2')
})

test('latestSessionOfMode：该模式无会话 / 空列表 → null', () => {
  const list = mkSessions([['s1', 'agent', 100]])
  assert.equal(L.latestSessionOfMode(list, 'llm'), null)
  assert.equal(L.latestSessionOfMode([], 'agent'), null)
})

test('latestSessionOfMode：单会话直接命中（不突变输入）', () => {
  const list = mkSessions([['s1', 'llm', 100]])
  const r = L.latestSessionOfMode(list, 'llm')
  assert.equal(r?.id, 's1')
  assert.equal(list.length, 1)
})
