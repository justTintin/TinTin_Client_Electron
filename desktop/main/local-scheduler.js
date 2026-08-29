// ═══════════════════════════════════════════════════════════════
// local-scheduler.js — 本地定时任务管理（P2 移植）
// 基准：原客户端 studio/utils/local_scheduler.py（逐行为对照移植）。
// 基于 Windows 任务计划程序（schtasks）注册/查询/删除客户端内置任务，
// 任务定义持久化在 userData/local_scheduled_tasks.json。
//
// 载体替换（移植基线：零 Python 依赖）：原版 /tr 为内联 Python 代码；
// Electron 版 /tr 为「应用自身 + --tintin-scheduled=<type>:<task_name>」——
// 到点由主进程接管：agent 类型读清单 goal → POST /agent/tasks（服务端
// Orchestrator 自动拆解执行，等价原版无 plan 时的回退路径）；
// hotspot 类型拉起主窗口并切到浏览器 Tab（热点自动采集联动后续版本）。
// ═══════════════════════════════════════════════════════════════

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { httpRequest, API_ENDPOINTS } = require('./server-proxy')

const TASK_PREFIX = 'TinTinAI_'
const SCHEDULED_ARG_PREFIX = '--tintin-scheduled='
const TASK_TYPES = ['hotspot', 'agent']

const WEEKDAY_ABBR = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

// schtasks 上次结果：0x0=成功；0x41303（十进制 267011）= 任务从未运行
const HAS_NOT_RUN_VALUES = ['267011', '0x41303', '41303']

// ── 纯函数（与原版 _parse_query_info/_result_text/_schedule_text 逐行为对照）──

/** 解析 schtasks /query /v LIST 输出 → 关键字段 dict（中英文键兼容） */
function parseQueryInfo(out) {
  const info = {}
  for (const line of String(out || '').split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (!key || !val) continue
    if (['下次运行时间', '上次运行时间', '上次结果', '状态',
      'Next Run Time', 'Last Run Time', 'Last Result', 'Status'].includes(key)) {
      info[key] = val
    }
  }
  return info
}

/** 上次结果（0/0x0=成功，0x41303=从未运行）→ 可读文本 */
function resultText(val) {
  if (!val) return '—'
  const v = String(val).replace(/^[()]+|[()]+$/g, '')
  if (v === '0' || v === '0x0') return '成功'
  if (HAS_NOT_RUN_VALUES.includes(v)) return '尚未运行'
  return String(val)
}

/** 调度配置 → 展示文本。schedule: {mode, time, weekdays} */
function scheduleText(schedule) {
  const s = schedule || {}
  const mode = s.mode || 'daily'
  const timeStr = s.time || ''
  if (mode === 'weekly') {
    const days = s.weekdays || []
    let dayText = days.filter((d) => d >= 0 && d <= 6).map((d) => '一二三四五六日'[d]).join('、')
    if (dayText) dayText = `周${dayText}`
    return dayText ? `每周 ${dayText} ${timeStr}` : `每周 ${timeStr}`
  }
  return `每天 ${timeStr}`
}

/**
 * 校验新建参数（与原版 create_task 前置校验逐条对照）。
 * 返回 { ok:true, safe, taskName } 或 { ok:false, msg }
 */
function validateCreate({ name, taskType = 'hotspot', schedule = {}, goal = '' }) {
  const mode = schedule.mode || 'daily'
  if (mode !== 'daily' && mode !== 'weekly') return { ok: false, msg: `不支持的调度方式: ${mode}` }
  if (!TASK_TYPES.includes(taskType)) return { ok: false, msg: `不支持的本地任务类型: ${taskType}` }
  if (taskType === 'agent' && !String(goal || '').trim()) {
    return { ok: false, msg: '云端智能体任务需要任务描述（goal）' }
  }
  const timeStr = schedule.time || '09:00'
  if (!/^\d{2}:\d{2}$/.test(timeStr)) return { ok: false, msg: `时间格式应为 HH:MM：${timeStr}` }
  const safe = String(name || '').replace(/[^0-9A-Za-z\u4e00-\u9fff_-]/g, '').trim()
  if (!safe) return { ok: false, msg: '任务名称不能为空' }
  return { ok: true, safe, taskName: `${TASK_PREFIX}${safe}`, mode, timeStr }
}

/** 构建 schtasks /create 参数（纯函数，便于单测；weekly 星期缺省校验在此） */
function buildCreateArgs({ taskName, mode, timeStr, weekdays = [] }) {
  const args = ['/create', '/f', '/tn', taskName, '/tr', '__TR_PLACEHOLDER__',
    '/sc', mode === 'daily' ? 'DAILY' : 'WEEKLY', '/st', timeStr]
  if (mode === 'weekly') {
    const days = [...new Set(weekdays.filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b)
    if (!days.length) return { ok: false, msg: '每周模式至少选择一个星期' }
    args.push('/d', days.map((d) => WEEKDAY_ABBR[d]).join(','))
  }
  return { ok: true, args }
}

/** 构建 /tr 到点执行命令（载体替换：应用自身 + --tintin-scheduled 参数） */
function buildTriggerCommand(taskType, taskName) {
  const execPath = process.execPath
  if (app.isPackaged) {
    return `"${execPath}" ${SCHEDULED_ARG_PREFIX}${taskType}:${taskName}`
  }
  // dev：electron.exe 需显式携带 app 路径
  return `"${execPath}" "${app.getAppPath()}" ${SCHEDULED_ARG_PREFIX}${taskType}:${taskName}`
}

// ── 持久化（userData/local_scheduled_tasks.json）──

function tasksFile() {
  return path.join(app.getPath('userData'), 'local_scheduled_tasks.json')
}

function loadTasks() {
  try {
    if (fs.existsSync(tasksFile())) {
      return JSON.parse(fs.readFileSync(tasksFile(), 'utf-8'))
    }
  } catch (e) {
    console.warn('[本地定时] 读取任务清单失败:', e.message)
  }
  return []
}

function saveTasks(tasks) {
  try {
    fs.mkdirSync(path.dirname(tasksFile()), { recursive: true })
    fs.writeFileSync(tasksFile(), JSON.stringify(tasks, null, 2), 'utf-8')
    return true
  } catch (e) {
    console.warn('[本地定时] 保存任务清单失败:', e.message)
    return false
  }
}

// ── schtasks 执行（GBK 编码输出）──

function schtasks(args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile('schtasks', args, { encoding: 'buffer', timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) return resolve({ code: -1, out: String(err.message || err) })
      // 优先按 GBK 解码（中文 Windows schtasks 输出为 GBK/ANSI）
      let text = ''
      try {
        text = new TextDecoder('gbk').decode(stdout || Buffer.alloc(0))
      } catch (_) {
        text = String(stdout || '')
      }
      if (err && !text) text = String(err.message || '')
      if (stderr) {
        try { text += new TextDecoder('gbk').decode(stderr) } catch (_) { text += String(stderr) }
      }
      resolve({ code: err && !stdout ? (err.code ?? -1) : 0, out: text })
    })
  })
}

// ── 对外 API（IPC 调用）──

/** 注册本地定时任务。返回 [true, taskName] 或 [false, 错误信息]（对齐原版元组） */
async function createTask({ name, taskType = 'hotspot', schedule = {}, goal = '', plan = null }) {
  const v = validateCreate({ name, taskType, schedule, goal })
  if (!v.ok) return [false, v.msg]
  if (loadTasks().some((t) => t.task_name === v.taskName)) {
    return [false, `同名任务已存在：${v.taskName}`]
  }
  const built = buildCreateArgs({ taskName: v.taskName, mode: v.mode, timeStr: v.timeStr, weekdays: schedule.weekdays })
  if (!built.ok) return [false, built.msg]
  const args = built.args.slice()
  args[args.indexOf('__TR_PLACEHOLDER__')] = buildTriggerCommand(taskType, v.taskName)
  const { code, out } = await schtasks(args)
  if (code !== 0) return [false, (out || '').trim() || `schtasks 创建失败（退出码 ${code}）`]

  const tasks = loadTasks()
  tasks.push({
    task_name: v.taskName,
    name: v.safe,
    type: taskType,
    schedule: {
      mode: v.mode,
      time: v.timeStr,
      weekdays: v.mode === 'weekly' ? (schedule.weekdays || []) : []
    },
    goal: taskType === 'agent' ? String(goal || '').trim() : '',
    // agent 注册时 LLM 拆解出的执行步骤，随任务保存，到点优先提交（对齐原版 plan 字段）
    plan: taskType === 'agent' ? (plan || null) : null,
    created_at: new Date().toLocaleString('sv-SE').replace('T', ' ')
  })
  saveTasks(tasks)
  console.log(`[本地定时] 已注册任务 ${v.taskName}（${v.mode} ${v.timeStr}）`)
  return [true, v.taskName]
}

/** 本地任务清单 + schtasks 实时状态合并（对齐原版 list_tasks） */
async function listTasks() {
  const tasks = loadTasks()
  const merged = []
  for (const t of tasks) {
    const item = { ...t }
    const { code, out } = await schtasks(['/query', '/tn', t.task_name || '', '/fo', 'LIST', '/v'])
    if (code === 0) {
      const info = parseQueryInfo(out)
      item.registered = true
      item.next_run = info['下次运行时间'] || info['Next Run Time'] || ''
      item.last_run = info['上次运行时间'] || info['Last Run Time'] || ''
      item.last_result = info['上次结果'] || info['Last Result'] || ''
    } else {
      item.registered = false
      item.next_run = item.last_run = item.last_result = ''
    }
    merged.push(item)
  }
  return merged
}

/** 注销本地定时任务（schtasks /delete + 清理清单）。name 为任务名或 task_name */
async function deleteTask(name) {
  const tasks = loadTasks()
  const idx = tasks.findIndex((x) => x.task_name === name || x.name === name)
  if (idx < 0) return [false, '任务不在本地清单中']
  const { code, out } = await schtasks(['/delete', '/f', '/tn', tasks[idx].task_name])
  if (code !== 0) return [false, (out || '').trim() || `schtasks 删除失败（退出码 ${code}）`]
  const [removed] = tasks.splice(idx, 1)
  saveTasks(tasks)
  console.log(`[本地定时] 已注销任务 ${removed.task_name}`)
  return [true, removed.task_name]
}

/** 立即运行已注册的本地任务（schtasks /run） */
async function runNow(taskName) {
  const { code, out } = await schtasks(['/run', '/tn', taskName])
  if (code === 0) return [true, '已触发执行']
  return [false, (out || '').trim() || '触发失败']
}

/**
 * 到点执行入口（--tintin-scheduled=<type>:<task_name>）。
 * agent：读清单 → plan 优先（注册时拆解保存）/ 回退按 goal 由服务端拆解
 *        → POST /agent/tasks（对齐原版内联代码语义）；
 * hotspot：返回 true 由 main.js 拉起窗口并切浏览器 Tab。
 */
async function runScheduledTrigger(argValue) {
  const m = /^(hotspot|agent):(.+)$/.exec(String(argValue || ''))
  if (!m) return false
  const [, type, taskName] = m
  const me = loadTasks().find((t) => t.task_name === taskName)
  if (!me) {
    console.warn(`[本地定时] 到点任务不在清单中：${taskName}`)
    return false
  }
  if (type === 'agent') {
    const submit = buildAgentSubmitBody(me)
    if (!submit) {
      console.warn(`[本地定时] 任务 ${taskName} 缺少任务描述，跳过提交`)
      return false
    }
    try {
      const res = await httpRequest('POST', API_ENDPOINTS.agent.tasks, { ...submit, timeout: 30000 })
      console.log(`[本地定时] 已到点提交编排任务：${taskName} →`, res && res.task_id ? res.task_id : res)
      return true
    } catch (e) {
      console.warn(`[本地定时] 编排任务提交失败（${taskName}）:`, e.message)
      return false
    }
  }
  return true // hotspot：由 setupTriggerRelay 采完后切浏览器 Tab
}

/** 解析 argv 中的 --tintin-scheduled 参数值；无则 null */
function findScheduledArg(argv) {
  const hit = (argv || []).find((a) => String(a).startsWith(SCHEDULED_ARG_PREFIX))
  return hit ? hit.slice(SCHEDULED_ARG_PREFIX.length) : null
}

/**
 * agent 任务到点提交体（纯函数，对齐原版内联代码语义）：
 * plan 优先（注册时 LLM 拆解并保存）；无 plan 回退按 goal 由服务端拆解。
 */
function buildAgentSubmitBody(task) {
  const goal = String((task && task.goal) || '').trim()
  const plan = (task && task.plan) || null
  if (plan && typeof plan === 'object' && Array.isArray(plan.steps) && plan.steps.length) {
    return { body: { goal: String(plan.goal || goal), plan, mode: 'execute' } }
  }
  return goal ? { body: { goal, mode: 'execute' } } : null
}

// ── P4 到点触发中继（从 main.js 移入，保持单文件 ≤800 行铁律）──
const hotspotCapture = require('./hotspot-capture')

/**
 * 到点触发中继：主进程注入窗口/目录句柄，本模块负责完整编排。
 * hotspot：自动采集今日热榜（隐藏 BrowserView，对照原版
 *          launch_hotspot_capture(auto_quit=True) 无感语义）→ 完成后拉窗
 *          + 发 scheduled:hotspot-trigger（主窗口 App.vue 打开浏览器窗口；
 *          浏览器独立窗口自含订阅 navigateToHotspot）；
 * agent：runScheduledTrigger（plan 优先提交服务端）。
 * @param {{ getWindow: ()=>BrowserWindow, getExtraWindow?: ()=>BrowserWindow|null,
 *           getUserDataDir: ()=>string, progressChannel: string }} deps
 */
function setupTriggerRelay({ getWindow, getExtraWindow, getUserDataDir, progressChannel }) {
  let pendingHotspot = null
  function sendHotspotTrigger(count) {
    const countVal = typeof count === 'number' ? count : null
    const payload = { count: countVal }
    const win = getWindow()
    if (!win) {
      pendingHotspot = { count: countVal }
      return
    }
    if (win.isMinimized()) win.restore()
    win.focus()
    win.webContents.send('scheduled:hotspot-trigger', payload)
    // D5：浏览器独立窗口也收 hotspot 触发（自含订阅 onScheduledHotspot → navigateToHotspot）
    try {
      const extra = getExtraWindow && getExtraWindow()
      if (extra && !extra.isDestroyed()) extra.webContents.send('scheduled:hotspot-trigger', payload)
    } catch (_) {}
    pendingHotspot = null
  }
  /** 窗口未就绪时暂存 → did-finish-load 后补发 */
  function flushPendingHotspot() {
    if (!pendingHotspot) return false
    const win = getWindow()
    if (!win) return false
    const count = pendingHotspot.count
    win.webContents.once('did-finish-load', () => sendHotspotTrigger(count))
    pendingHotspot = null
    return true
  }
  /** 采集今日热点 + 推平台级进度 + 完成后切浏览器 Tab（定时到点与手动采集共用） */
  async function runHotspotCapture() {
    const [ok, data] = await hotspotCapture.captureHotspots({
      userDataDir: getUserDataDir(),
      onProgress: (p) => {
        try {
          const win = getWindow()
          if (win) win.webContents.send(progressChannel, p)
        } catch (_) { /* 进度推送失败不影响采集 */ }
      },
    }).catch((e) => [false, String((e && e.message) || e)])
    if (ok) sendHotspotTrigger(typeof data === 'number' ? data : null)
    return [ok, data]
  }
  /** 到点/第二实例共用入口：hotspot=采集+切 Tab；agent=提交服务端 */
  async function handleScheduledArg(arg) {
    if (!arg) return
    if (arg.startsWith('hotspot:')) {
      await runHotspotCapture().catch(() => {})
      return
    }
    await runScheduledTrigger(arg).catch(() => false)
  }
  return { sendHotspotTrigger, runHotspotCapture, handleScheduledArg, flushPendingHotspot, hasPendingHotspot: () => !!pendingHotspot }
}

module.exports = {
  TASK_PREFIX,
  parseQueryInfo,
  resultText,
  scheduleText,
  validateCreate,
  buildCreateArgs,
  buildTriggerCommand,
  buildAgentSubmitBody,
  createTask,
  listTasks,
  deleteTask,
  runNow,
  runScheduledTrigger,
  findScheduledArg,
  setupTriggerRelay
}
