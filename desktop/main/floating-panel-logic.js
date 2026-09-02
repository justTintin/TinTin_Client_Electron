// ═══════════════════════════════════════════════════════════════
// floating-panel-logic.js — 浮动面板自动关闭状态机（纯逻辑，可单测）
// 从 main.js _openFloatingPanel 的 blur→延时关闭 内联逻辑抽出：
//   · show 前 blur 忽略（防初始化闪烁误关，原 _r 旗标语义）
//   · show 后 blur → closeDelayMs 后触发 onFire（关闭面板，原 _fpBlurTimer 语义）
//   · busy（原生文件对话框/安装流程进行中）→ 暂停自动关闭并取消已挂起触发，
//     解除后恢复——修复「点安装扩展选完文件面板已被销毁，安装永不执行且无提示」
//     （2026-09-02 用户反馈；定时器经 scheduleFn/cancelFn 注入以便单测）
// ═══════════════════════════════════════════════════════════════

/**
 * 创建浮动面板自动关闭控制器
 * @param {{ closeDelayMs?: number, onFire: () => void,
 *           scheduleFn?: (fn: () => void, ms: number) => any,
 *           cancelFn?: (id: any) => void }} opts
 */
function createPanelAutoClose({ closeDelayMs = 150, onFire, scheduleFn = setTimeout, cancelFn = clearTimeout } = {}) {
  let ready = false
  let busy = false
  let timer = null

  function _cancelPending() {
    if (timer != null) {
      try { cancelFn(timer) } catch (_) {}
      timer = null
    }
  }

  return {
    /** 面板 ready-to-show/show 后调用（原 _r = true） */
    markShow() { ready = true },
    /** 设置/解除忙态（文件对话框等模态流程）；进入忙态同时取消已挂起的关闭 */
    setBusy(v) {
      busy = !!v
      if (busy) _cancelPending()
    },
    isBusy() { return busy },
    /** 面板失焦；返回是否调度了延时关闭（false = 忽略/被 busy 暂停） */
    blur() {
      if (!ready) return false
      if (busy) return false
      _cancelPending()
      timer = scheduleFn(() => { timer = null; try { onFire() } catch (_) {} }, closeDelayMs)
      return true
    },
    hasPendingClose() { return timer != null },
    /** 面板销毁时清理挂起定时器 */
    dispose() { _cancelPending() },
  }
}

module.exports = { createPanelAutoClose }
