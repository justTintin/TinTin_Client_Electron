// ═══════════════════════════════════════════════════════════════
// useSettingsConfig — 设置页 IPC 配置读写（无状态纯函数工具层）
// 从 Settings.vue 原样迁出（行为不变，IRON-08）；供
// useSettingsGeneral / useSettingsExtension 共享导入。
// 注意：本模块不持有任何响应式状态，两个业务 composable 之间
// 不允许互相 import 内部状态，共享逻辑只收敛在这里。
// ═══════════════════════════════════════════════════════════════

/** 获取 preload 暴露的 tintin 桥（壳外纯浏览器预览时为 undefined） */
export function getTintin(): any {
  return (window as any).tintin
}

/** 是否具备 env IPC 能力 */
export function hasEnv(): boolean {
  return !!getTintin()?.env
}

/** 是否具备 config IPC 能力 */
export function hasConfig(): boolean {
  return !!getTintin()?.config
}

/** 读 electron-store 配置（无 IPC 返回默认） */
export async function readCfg(key: string, def: string | boolean): Promise<string | boolean> {
  if (!hasConfig()) return def
  try { return (await getTintin().config.get(key)) ?? def } catch (_) { return def }
}

/** 写配置到 electron-store（无 IPC 静默） */
export async function writeCfg(key: string, val: any): Promise<void> {
  if (!hasConfig()) return
  try { await getTintin().config.set(key, val) } catch (_) {}
}
