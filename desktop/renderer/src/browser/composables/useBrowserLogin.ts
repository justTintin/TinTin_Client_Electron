// ═══════════════════════════════════════════════════════════════
// useBrowserLogin — 浏览器登录状态域 composable（条目⑧ B11）（D2 搬迁）
// 检测链路：复用既有 browser:cookieList IPC（thickShell-ipc.js L367，
// 返回各平台 persist:tintin-* 分区 cookies 摘要）→ browserLoginLogic
// 纯函数判定 → 工具栏徽章 / 左栏平台状态点。
// 对照原客户端：check-login-status main.js L1016-1041（cookie 特征判定）
//   + renderLoginStatusBadges app.js L1698-1736（每平台徽章）。
// 异常口径：任一平台检测失败（IPC 异常/未知平台）置该平台为 logged_out，
//   整体静默——徽章失败不阻塞浏览（原版 catch 返回全 false 同语义）。
// D2 解耦：IPC 由 window.tintin → window.tintinBrowser（browser-preload.js）。
//   主应用设置页（CardAccountLogin.vue）仍引用本模块的 loginStateText /
//   LoginState（纯函数与类型），运行时工厂仅在浏览器窗口调用，不冲突。
// ═══════════════════════════════════════════════════════════════

import { ref, computed } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { judgeLoginState, loginStateText } from './browserLoginLogic'
import type { LoginCookieLike, LoginState } from './browserLoginLogic'

export type { LoginState }
export { loginStateText }

export interface UseBrowserLoginReturn {
  /** 各平台登录态（key=platformId，未检测的平台无键） */
  loginStates: Ref<Record<string, LoginState>>
  /** 全量检测中标记 */
  checking: Ref<boolean>
  /** 当前激活平台的登录态（工具栏徽章用；未知平台 → checking） */
  activeLoginState: ComputedRef<LoginState>
  /** 全量检测（并行，任一失败静默不阻塞） */
  refreshAll: (platformIds: string[]) => Promise<void>
  /** 单平台重检（onViewReady 页面加载完成 / 徽章点击刷新） */
  refreshOne: (platformId: string) => Promise<void>
}

export function useBrowserLogin(activeNavId: Ref<string>): UseBrowserLoginReturn {
  const loginStates = ref<Record<string, LoginState>>({})
  const checking = ref(false)

  /** 读一个平台分区的 cookies → 判定（IPC 异常静默为 logged_out） */
  async function probeOne(platformId: string): Promise<void> {
    const t = (window as any).tintinBrowser
    let state: LoginState = 'logged_out'
    try {
      if (t?.browser?.cookieList) {
        const r = await t.browser.cookieList(platformId)
        const cookies: LoginCookieLike[] = r?.success && r?.data ? (r.data.cookies || []) : []
        state = judgeLoginState(platformId, cookies)
      }
    } catch (_) {
      state = 'logged_out' // 检测失败不阻塞浏览（对照原版 catch 全 false）
    }
    loginStates.value = { ...loginStates.value, [platformId]: state }
  }

  /** 全量并行检测（7 平台互不阻塞） */
  async function refreshAll(platformIds: string[]): Promise<void> {
    if (checking.value) return
    checking.value = true
    // 先置检测中态（徽章立即有反馈）
    const seed: Record<string, LoginState> = { ...loginStates.value }
    for (const id of platformIds) seed[id] = 'checking'
    loginStates.value = seed
    try {
      await Promise.all(platformIds.map((id) => probeOne(id)))
    } finally {
      checking.value = false
    }
  }

  async function refreshOne(platformId: string): Promise<void> {
    loginStates.value = { ...loginStates.value, [platformId]: 'checking' }
    await probeOne(platformId)
  }

  const activeLoginState = computed<LoginState>(() => {
    const s = loginStates.value[activeNavId.value]
    return s ?? 'checking'
  })

  return { loginStates, checking, activeLoginState, refreshAll, refreshOne }
}
