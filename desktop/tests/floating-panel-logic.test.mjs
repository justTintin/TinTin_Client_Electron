// ══════════════════════════════════════════════════════════════
// floating-panel-logic.test.mjs — 浮动面板自动关闭状态机·纯函数单测
// （2026-09-02 用户反馈：扩展面板点「+ 安装扩展」选完 zip 后安装失败且无提示。
//   根因：面板 blur 150ms 自动关闭把面板窗口销毁——原生文件对话框一弹出面板
//   就失焦被销毁，选完文件后安装 IPC 无渲染上下文可回，安装从未执行。
//   修复口径：busy（文件对话框/安装流程进行中）时暂停自动关闭，结束后恢复）
// 运行：node --test "tests/*.test.mjs"
// ══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { createPanelAutoClose } = await import('../main/floating-panel-logic.js')

/** 假定时器：scheduleFn/cancelFn 注入，手动 advance 推进（按时间轴累计） */
function makeFakeTimers() {
  let seq = 0
  let now = 0
  const timers = new Map() // id → { deadline, fn }
  return {
    scheduleFn(fn, ms) { const id = ++seq; timers.set(id, { deadline: now + ms, fn }); return id },
    cancelFn(id) { timers.delete(id) },
    advance(ms) {
      now += ms
      for (const [id, t] of [...timers]) {
        if (t.deadline <= now) { timers.delete(id); t.fn() }
      }
    },
    pending() { return timers.size },
  }
}

function makeCtrl(fake, { closeDelayMs = 150 } = {}) {
  const fired = []
  const ctrl = createPanelAutoClose({
    closeDelayMs,
    scheduleFn: fake.scheduleFn,
    cancelFn: fake.cancelFn,
    onFire: () => fired.push(Date.now()),
  })
  return { ctrl, fired }
}

test('未 markShow 前 blur 忽略（防初始化闪烁误关）', () => {
  const fake = makeFakeTimers()
  const { ctrl, fired } = makeCtrl(fake)
  assert.equal(ctrl.blur(), false)
  fake.advance(500)
  assert.equal(fired.length, 0)
})

test('markShow 后 blur 调度延时关闭，推进后触发一次', () => {
  const fake = makeFakeTimers()
  const { ctrl, fired } = makeCtrl(fake)
  ctrl.markShow()
  assert.equal(ctrl.blur(), true)
  fake.advance(100)
  assert.equal(fired.length, 0, '150ms 未到不触发')
  fake.advance(100)
  assert.equal(fired.length, 1, '到点触发关闭')
})

test('busy=true 时 blur 不调度自动关闭（文件对话框流程中）', () => {
  const fake = makeFakeTimers()
  const { ctrl, fired } = makeCtrl(fake)
  ctrl.markShow()
  ctrl.setBusy(true)
  assert.equal(ctrl.blur(), false)
  fake.advance(500)
  assert.equal(fired.length, 0)
})

test('busy=true 取消已挂起的关闭（先 blur 再进入 busy）', () => {
  const fake = makeFakeTimers()
  const { ctrl, fired } = makeCtrl(fake)
  ctrl.markShow()
  ctrl.blur()
  assert.equal(fake.pending(), 1)
  ctrl.setBusy(true)
  assert.equal(fake.pending(), 0, '挂起的关闭被取消')
  fake.advance(500)
  assert.equal(fired.length, 0)
})

test('busy 解除后 blur 恢复自动关闭', () => {
  const fake = makeFakeTimers()
  const { ctrl, fired } = makeCtrl(fake)
  ctrl.markShow()
  ctrl.setBusy(true)
  ctrl.setBusy(false)
  assert.equal(ctrl.blur(), true)
  fake.advance(200)
  assert.equal(fired.length, 1)
})

test('连续 blur 重置定时器（两次 blur 只关闭一次）', () => {
  const fake = makeFakeTimers()
  const { ctrl, fired } = makeCtrl(fake)
  ctrl.markShow()
  ctrl.blur()
  fake.advance(100)
  ctrl.blur() // 重置
  fake.advance(140) // 距第二次 blur 140ms < 150ms
  assert.equal(fired.length, 0, '定时器已被重置')
  fake.advance(20)
  assert.equal(fired.length, 1, '只触发一次')
})
