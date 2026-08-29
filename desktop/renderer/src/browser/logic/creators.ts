// ═══════════════════════════════════════════════════════════════
// creators — B10 达人/创作者库前端纯函数（无 vue/IPC 依赖，供单测）
// 对照基准（以原代码为准）：
//   · apps/asset-browser/main.js L543-564 creators DB（id+platform 唯一键）
//   · apps/asset-browser/renderer/app.js L1258-1312 collectAllFromCreator
//     （达人主页采集 → 自动滚动 → 收集内容；新客户端采集 runner 在主进程
//       main/creators-store.js，本模块只做前端展示数据编组/筛选）
//   · 采集清单条目结构 {platform, creatorId, creatorName, title, url,
//     source, date, collectedAt}（落 userData/creators/collected.json）
// ═══════════════════════════════════════════════════════════════

export interface CreatorItem {
  id: string
  platform: string
  name: string
  homepageUrl?: string
  addedAt?: number
}

export interface CollectedItem {
  platform: string
  creatorId: string
  creatorName: string
  title: string
  url: string
  source: string
  date: string
  collectedAt: string
  /** B8 素材入库状态标注（collected.json 回写）：submitted 待处理 / imported 已入库 / failed 失败+原因 */
  importStatus?: 'submitted' | 'imported' | 'failed' | string
  importTaskId?: string
  importError?: string
  importedAt?: string
}

/** 达人列表搜索筛选（名称/平台/主页 URL 子串，不区分大小写；空查询返回原列表） */
export function filterCreators(list: CreatorItem[] | null | undefined, query?: string): CreatorItem[] {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return list || []
  return (list || []).filter((c) =>
    (c.name || '').toLowerCase().includes(q) ||
    (c.platform || '').toLowerCase().includes(q) ||
    (c.homepageUrl || '').toLowerCase().includes(q)
  )
}

/** 采集清单编组模式：date=按日期降序（默认） / creator=按达人名升序 */
export type CollectedGroupMode = 'date' | 'creator'

export interface CollectedGroup {
  key: string
  items: CollectedItem[]
}

/**
 * 采集清单编组（B10 单测点）：
 *   date     → 按 date 编组，组间日期降序（同组保持采集顺序）
 *   creator  → 按 creatorName 编组，组间名称升序
 */
export function groupCollectedItems(
  items: CollectedItem[] | null | undefined,
  mode: CollectedGroupMode = 'date'
): CollectedGroup[] {
  const map = new Map<string, CollectedItem[]>()
  for (const it of (items || [])) {
    const key = mode === 'creator'
      ? (it.creatorName || it.creatorId || '未知达人')
      : (it.date || '未知日期')
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(it)
  }
  const arr = Array.from(map.entries())
  arr.sort((a, b) => {
    if (mode === 'creator') return a[0].localeCompare(b[0])
    return b[0].localeCompare(a[0]) // 日期降序
  })
  return arr.map(([key, list]) => ({ key, items: list }))
}

/** 平台徽标文案（对照原版平台名映射：douyin=抖音/bilibili=B站/...） */
export function platformDisplayName(platform: string): string {
  const map: Record<string, string> = {
    douyin: '抖音',
    bilibili: 'B站',
    kuaishou: '快手',
    xiaohongshu: '小红书',
    weixin: '视频号',
    youtube: 'YouTube',
    jimeng: '即梦AI',
  }
  return map[platform] || platform
}

/** B8 入库状态徽标元信息（submitted=待处理 / imported=已入库 / failed=失败+原因） */
export type CollectedImportStatus = CollectedItem['importStatus']

export function importStatusMeta(status: CollectedImportStatus): { text: string; cls: string } {
  if (status === 'submitted') return { text: '待处理', cls: 'pending' }
  if (status === 'imported') return { text: '已入库', cls: 'done' }
  if (status === 'failed') return { text: '失败', cls: 'fail' }
  return { text: '', cls: '' }
}

/** 入库结果 → 汇总提示文案（主进程 material:import 返回 data 的摘要） */
export function importResultMessage(d: {
  submitted?: number
  failed?: number
  duplicates?: number
  noUrl?: number
  firstError?: string
} | null | undefined): string {
  if (!d) return '入库失败'
  const parts: string[] = [`已提交 ${Number(d.submitted) || 0} 条`]
  if (Number(d.failed) > 0) parts.push(`失败 ${d.failed} 条`)
  if (Number(d.duplicates) > 0) parts.push(`去重 ${d.duplicates} 条`)
  if (Number(d.noUrl) > 0) parts.push(`无链接 ${d.noUrl} 条`)
  const msg = parts.join('，')
  return d.firstError ? `${msg}（${d.firstError}）` : msg
}
