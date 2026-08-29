// ═══════════════════════════════════════════════════════════════
// useEnvCheck — 条目⑪ 环境检测 composable（设置页「环境与维护」卡）
// 口径重定义（原 gui/env_config_page.py L412-513 为 Python 依赖矩阵，
// 新端无 Python）：服务端连通 + 服务端能力健康 + 本地资源轻量项。
// 数据源：
//   · env:detectEnv      主进程（ping + ffmpeg/磁盘/os/cpu/ram）
//   · server.healthCapabilities  /health/capabilities 12 能力（复用既有通道）
// 编组在 envCheckLogic.groupEnvReport（纯函数，有单测）。
// 异常分支：无 IPC（预览环境 unknown 行）/ 服务端离线（bad）/
//   能力 5xx（bad 透出错误）/ 本地检测异常（unknown，不误报）。
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'
import { groupEnvReport } from './envCheckLogic'
import type { EnvCheckRow } from './envCheckLogic'
import { getTintin } from './useSettingsConfig'

export function useEnvCheck() {
  const envRows = ref<EnvCheckRow[]>([])
  const envChecking = ref(false)

  /** 运行环境检测（CardEnvMaint「开始检测」按钮 / 容器进入自动触发可选） */
  async function runEnvCheck(): Promise<void> {
    if (envChecking.value) return
    envChecking.value = true
    try {
      const t = getTintin()
      if (!t?.env?.detectEnv) {
        envRows.value = [{
          label: '环境检测', state: 'unknown', detail: '预览环境：无 IPC，无法检测',
        }]
        return
      }
      // 并行：主进程本地资源 + 能力健康（能力失败不影响本地行评估）
      const [report, caps] = await Promise.all([
        t.env.detectEnv(),
        (async () => {
          try { return await t?.server?.healthCapabilities?.() ?? null } catch (_e) { return null }
        })(),
      ])
      envRows.value = groupEnvReport(report ?? null, caps ?? null)
    } catch (e) {
      // 网络失败/IPC 异常兜底：整列 unknown（不误报业务失败）
      envRows.value = [{
        label: '环境检测', state: 'unknown', detail: `检测失败：${String((e as any)?.message || e)}`,
      }]
    } finally {
      envChecking.value = false
    }
  }

  return { envRows, envChecking, runEnvCheck }
}
