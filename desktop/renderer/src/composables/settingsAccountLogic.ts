// ═══════════════════════════════════════════════════════════════
// settingsAccountLogic — 账号与登录（飞书/即梦）编组纯函数（条目⑩ S6+S7）
// 对照原客户端（以原代码为准）：
//   · gui/main_window_aiconfig.py L537-583 load/save_feishu_config：
//     [Feishu] AppId/AppSecret/AppToken/TableId/TopicField(默认"选题")/
//     ScriptField(默认"脚本")/FolderToken —— 新客户端逐字段对齐语义，
//     存放由 ini 换为 electron-store（键 feishu.*，主进程可读）
//   · L584-600 _test_feishu：POST https://open.feishu.cn/open-apis/auth/v3/
//     tenant_access_token/internal {app_id, app_secret}（timeout 10s）；
//     成功 = HTTP 200 且响应含 tenant_access_token；缺参拦截
//     「请填入 App ID 和 Secret」
//   · L481-536 即梦 _dreamina_login/_dreamina_check：原版走 dreamina CLI
//     设备码 OAuth（Windows 专属），新客户端无 Python/CLI —— 口径替换为
//     内置浏览器分区（persist:tintin-jimeng）+ cookie 登录态检测
//     （复用条目⑧ browserLoginLogic），登录入口=浏览器「即梦AI」平台 Tab。
// 凭据安全：AppSecret 保存后 UI 只显示尾 4 位脱敏（maskSecret），
//   不回显明文；测试连接支持 useStored（主进程从 electron-store 读取，
//   明文不出现在展示层）。
// ═══════════════════════════════════════════════════════════════

/** 飞书字段元数据（key=渲染层字段名；storeKey=electron-store 键；secret=脱敏展示） */
export interface FeishuFieldMeta {
  key: string
  label: string
  storeKey: string
  def: string
  secret?: boolean
  placeholder?: string
}

/** 对齐原 load/save_feishu_config 七字段（L539-554 读取项 + L571-577 写入项） */
export const FEISHU_FIELDS: FeishuFieldMeta[] = [
  { key: 'appId',       label: 'App ID',       storeKey: 'feishu.appId',       def: '', placeholder: 'cli_xxxx' },
  { key: 'appSecret',   label: 'App Secret',   storeKey: 'feishu.appSecret',   def: '', secret: true, placeholder: '已保存则留空保持不变' },
  { key: 'appToken',    label: 'App Token',    storeKey: 'feishu.appToken',    def: '', placeholder: '多维表格 app token（bascn...）' },
  { key: 'tableId',     label: 'Table ID',     storeKey: 'feishu.tableId',     def: '', placeholder: '数据表 tableId' },
  { key: 'topicField',  label: '选题字段名',   storeKey: 'feishu.topicField',  def: '选题' },
  { key: 'scriptField', label: '脚本字段名',   storeKey: 'feishu.scriptField', def: '脚本' },
  { key: 'folderToken', label: 'Folder Token', storeKey: 'feishu.folderToken', def: '' },
]

/**
 * 凭据脱敏展示（条目⑩验收：保存后只显示尾 4 位之类）：
 * 空=未保存（返回空）；≤4 位全掩码；其余掩码+尾 4 位
 */
export function maskSecret(v: string): string {
  if (!v) return ''
  if (v.length <= 4) return '••••'
  return '••••' + v.slice(-4)
}

/** 测试连接参数校验（对照原 L589-591 拦截文案语义；''=通过） */
export function validateFeishuConn(appId: string, appSecret: string): string {
  if (!String(appId || '').trim() || !String(appSecret || '').trim()) {
    return '请填入 App ID 和 Secret'
  }
  return ''
}

/** 测试连接响应判定（对照原 L595-598；异常分支：5xx 透出状态码、null=网络失败） */
export function parseFeishuTestResult(
  resp: { status: number; json?: Record<string, unknown> } | null | undefined,
): { ok: boolean; message: string } {
  if (!resp) return { ok: false, message: '失败： 连接失败（网络不可达或超时）' }
  if (resp.status === 200 && resp.json && resp.json.tenant_access_token) {
    return { ok: true, message: '完成： 连接成功' }
  }
  const extra = resp.json && typeof resp.json.msg === 'string' ? `：${resp.json.msg}` : ''
  return { ok: false, message: `失败： HTTP ${resp.status}${extra}` }
}
