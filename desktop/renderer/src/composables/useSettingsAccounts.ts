// ═══════════════════════════════════════════════════════════════
// useSettingsAccounts — 设置页「账号与登录」域 composable（条目⑩ S6+S7）
// 飞书（S6）：七字段 electron-store 读写（键 feishu.* 对齐原 [Feishu] ini
//   语义，gui/main_window_aiconfig.py L537-583）+ 测试连接（feishu:testConn
//   主进程外网直连，对照原 _test_feishu L584-600）。
//   凭据脱敏：AppSecret 保存后 UI 只显示尾 4 位（settingsAccountLogic.maskSecret）；
//   已保存的 Secret 不回显明文，输入框留空=保持不变，输入新值=覆盖。
// 即梦（S7）：原版 dreamina CLI 设备码 OAuth（main_window_aiconfig.py
//   L481-536，Windows 专属）在无 Python 的新客户端不可复用 —— 口径替换为
//   内置浏览器分区 persist:tintin-jimeng + cookie 登录态检测（复用条目⑧
//   browserLoginLogic.judgeLoginState），登录入口=浏览器「即梦AI」平台 Tab。
//   注意（D2 搬迁）：browserLoginLogic 已随浏览器域迁至 src/browser/composables/，
//   本模块经相对路径引用该纯函数共享模块（无 vue/IPC 依赖）。
// 异常口径：网络失败/HTTP 非 200（含 5xx）/参数缺失/用户取消（无输入时
//   测试按钮前置校验拦截）四类分支齐备。
// ═══════════════════════════════════════════════════════════════

import { computed, ref } from 'vue'
import {
  FEISHU_FIELDS,
  maskSecret,
  validateFeishuConn,
} from './settingsAccountLogic'
import { judgeLoginState } from '../browser/composables/browserLoginLogic'
import type { LoginState } from '../browser/composables/browserLoginLogic'
import { getTintin, readCfg, writeCfg } from './useSettingsConfig'

export type FeishuFieldMap = Record<string, string>

/** 测试连接结果（null=未测试；对照原版状态标签 绿/红 语义） */
export interface ConnTestResult {
  ok: boolean
  message: string
}

export function useSettingsAccounts() {
  /* ── 飞书：七字段（secret 字段输入框只装「新输入值」，已存值不回显） ── */
  const feishu = ref<FeishuFieldMap>({})

  /** 已保存的 AppSecret 脱敏展示（''=未保存；保存后显示 ****尾4） */
  const appSecretStored = ref('')
  const appSecretMasked = computed(() => maskSecret(appSecretStored.value))

  const feishuSaving = ref(false)
  const feishuHint = ref('')
  const feishuTestBusy = ref(false)
  const feishuTestResult = ref<ConnTestResult | null>(null)

  /** 读取字段当前值（secret 字段返回空串——永不回显明文） */
  function fieldValue(key: string): string {
    if (key === 'appSecret') return '' // 明文只存在于 electron-store，不进展示层
    return feishu.value[key] ?? ''
  }

  /** 设置页进入时回读（容器 onMounted 调用） */
  async function loadFeishuCfg(): Promise<void> {
    const next: FeishuFieldMap = {}
    for (const f of FEISHU_FIELDS) {
      // readCfg 泛型约束为 string|boolean，数值类字段此处均为字符串，无需转换
      next[f.key] = String((await readCfg(f.storeKey, f.def)) ?? f.def)
    }
    feishu.value = next
    appSecretStored.value = next.appSecret || ''
  }

  /**
   * 保存（显式提交，对齐设置页其它卡口径）：逐字段写 electron-store；
   * AppSecret 仅在输入了新值时覆盖（留空=保持已存值）
   */
  async function saveFeishu(): Promise<boolean> {
    if (feishuSaving.value) return false
    feishuSaving.value = true
    feishuHint.value = ''
    try {
      for (const f of FEISHU_FIELDS) {
        if (f.secret) {
          const input = String(feishu.value[f.key] || '').trim()
          if (input) await writeCfg(f.storeKey, input)
        } else {
          await writeCfg(f.storeKey, String(feishu.value[f.key] ?? '').trim())
        }
      }
      // 保存后回读已存 Secret（主进程 electron-store 真相源）→ 脱敏展示
      appSecretStored.value = String((await readCfg('feishu.appSecret', '')) ?? '')
      if (feishu.value.appSecret) feishu.value.appSecret = '' // 清明文输入
      feishuHint.value = '飞书配置已保存'
      return true
    } catch (_e) {
      feishuHint.value = '保存失败'
      return false
    } finally {
      setTimeout(() => { feishuHint.value = ''; feishuSaving.value = false }, 1200)
    }
  }

  /** 测试连接（对照原 _test_feishu：缺参前置拦截；经主进程外网直连） */
  async function testFeishu(): Promise<void> {
    if (feishuTestBusy.value) return
    const appId = String(feishu.value.appId || '').trim()
    const secretInput = String(feishu.value.appSecret || '').trim()
    // 参数校验：输入为空且未存过 → 拦截（对照原 L589-591）
    if (!appId || (!secretInput && !appSecretStored.value)) {
      feishuTestResult.value = { ok: false, message: '失败： 请填入 App ID 和 Secret' }
      return
    }
    feishuTestBusy.value = true
    feishuTestResult.value = null
    const t = getTintin()
    try {
      if (!t?.feishu?.testConn) {
        feishuTestResult.value = { ok: false, message: '失败： 预览环境无 IPC' }
        return
      }
      // 输入了新 Secret 用新值；否则主进程从 electron-store 补全（明文不出展示层）
      const r = await t.feishu.testConn({ appId, appSecret: secretInput })
      feishuTestResult.value = {
        ok: !!r?.ok,
        message: String(r?.message || (r?.ok ? '完成： 连接成功' : '失败： 未知错误')),
      }
    } catch (e) {
      feishuTestResult.value = { ok: false, message: `失败： ${String((e as any)?.message || e)}` }
    } finally {
      feishuTestBusy.value = false
    }
  }

  /* ── 即梦（S7）：登录态检测（cookie 特征，复用条目⑧链路） ── */
  const jimengState = ref<LoginState>('checking')
  const jimengChecking = ref(false)

  /** 检测即梦登录态：browser:cookieList('jimeng') → judgeLoginState */
  async function checkJimeng(): Promise<void> {
    if (jimengChecking.value) return
    jimengChecking.value = true
    jimengState.value = 'checking'
    const t = getTintin()
    try {
      if (!t?.browser?.cookieList) {
        jimengState.value = 'unsupported' // 预览环境无 IPC → 未检测（不误判为检测中）
        return
      }
      const r = await t.browser.cookieList('jimeng')
      const cookies = r?.success && r?.data ? (r.data.cookies || []) : []
      jimengState.value = judgeLoginState('jimeng', cookies)
    } catch (_e) {
      jimengState.value = 'logged_out' // 检测失败静默为未登录（不阻塞）
    } finally {
      jimengChecking.value = false
    }
  }

  /* ── 2026-08-30 用户裁决：抖音登录态检测移除 ──
     原客户端账号页的抖音账户管理（多账户分身/独立登录窗口）依赖独立浏览器，
     新端无此形态；登录态在浏览器「抖音」分区自然存在，设置页不再重复展示。 */

  return {
    // 飞书
    feishu,
    FEISHU_FIELDS,
    fieldValue,
    appSecretMasked,
    feishuSaving,
    feishuHint,
    feishuTestBusy,
    feishuTestResult,
    loadFeishuCfg,
    saveFeishu,
    testFeishu,
    // 即梦
    jimengState,
    jimengChecking,
    checkJimeng,
  }
}
