// ═══════════════════════════════════════════════════════════════
// dailyAssets — B9 每日素材前端纯函数（无 vue/IPC 依赖，供单测）
// 对照基准（以原代码为准）：
//   · apps/asset-browser/renderer/app.js L2273-2312 getFilteredDailyMaterials：
//     日期/类型/搜索/排序 四维筛选 + 组内排序 + 组间日期排序
//   · 原版 L2314-2338 _buildMaterialPreviewHtml：图片直出、视频找同名
//     cover 封面、文本/文件图标（本模块返回预览类型供视图组件渲染）
//   · 主进程侧扫描见 main/daily-assets.js（scanDailyAssets）
// ═══════════════════════════════════════════════════════════════

export type AssetFileType = 'video' | 'image' | 'text' | 'file'

export interface DailyAssetFile {
  name: string
  path: string
  size: number
  type: AssetFileType
}

export interface DailyAssetGroup {
  date: string
  files: DailyAssetFile[]
}

/** 筛选条件（对照原版四个筛选项；sort 缺省 date_desc） */
export interface DailyAssetsFilter {
  date?: string
  type?: string
  query?: string
  sort?: string
}

/**
 * 每日素材筛选（对照原版 getFilteredDailyMaterials L2273-2312 逐段移植）：
 * 日期精确匹配 → 类型精确匹配 → 搜索 name/path 子串（不区分大小写）→
 * 组内排序（size_desc/size_asc/name_desc/name_asc/type_asc，缺省按名升序）→
 * 组间排序（date_asc 升序，其余降序）。空组剔除。
 */
export function filterDailyAssets(
  groups: DailyAssetGroup[] | null | undefined,
  filter: DailyAssetsFilter = {}
): DailyAssetGroup[] {
  const query = String(filter.query || '').trim().toLowerCase()
  const typeVal = filter.type || 'all'
  const dateVal = filter.date || 'all'
  const sortVal = filter.sort || 'date_desc'

  const out: DailyAssetGroup[] = []
  for (const group of (groups || [])) {
    if (dateVal !== 'all' && group.date !== dateVal) continue
    const files = (group.files || []).filter((file) => {
      if (typeVal !== 'all' && file.type !== typeVal) return false
      if (!query) return true
      const name = (file.name || '').toLowerCase()
      const p = (file.path || '').toLowerCase()
      return name.includes(query) || p.includes(query)
    })

    files.sort((a, b) => {
      const aName = (a.name || '').toLowerCase()
      const bName = (b.name || '').toLowerCase()
      if (sortVal === 'size_desc') return (b.size || 0) - (a.size || 0) || aName.localeCompare(bName)
      if (sortVal === 'size_asc') return (a.size || 0) - (b.size || 0) || aName.localeCompare(bName)
      if (sortVal === 'name_desc') return bName.localeCompare(aName)
      if (sortVal === 'name_asc') return aName.localeCompare(bName)
      if (sortVal === 'type_asc') {
        const byType = (a.type || '').localeCompare(b.type || '')
        return byType !== 0 ? byType : aName.localeCompare(bName)
      }
      return aName.localeCompare(bName)
    })

    if (files.length > 0) out.push({ date: group.date, files })
  }

  out.sort((a, b) => {
    if (sortVal === 'date_asc') return (a.date || '').localeCompare(b.date || '')
    return (b.date || '').localeCompare(a.date || '')
  })
  return out
}

/** 字节格式化（对照原版 formatBytes：B/KB/MB/GB 保留 1 位小数） */
export function formatBytes(b: number | undefined | null): string {
  const n = Number(b) || 0
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB'
}

/** 预览类型（对照原版 _buildMaterialPreviewHtml L2314-2338 的分支） */
export type MaterialPreviewType = 'image' | 'video-cover' | 'video' | 'text' | 'file'

/**
 * 判定素材卡预览类型：
 *   image       → 图片直出
 *   video-cover → 视频 + 同 baseName 且含 cover 的图片（封面预览 + 播放角标）
 *   video       → 视频无封面（播放图标）
 *   text        → 图文图标
 *   file        → 文件图标
 */
export function buildMaterialPreviewType(
  file: DailyAssetFile,
  groupFiles: DailyAssetFile[] | null | undefined
): MaterialPreviewType {
  if (file.type === 'image') return 'image'
  if (file.type === 'video') {
    const dot = (file.name || '').lastIndexOf('.')
    const baseName = dot > 0 ? file.name.substring(0, dot) : file.name
    const coverFile = (groupFiles || []).find(
      (f) => f.type === 'image' && f.name.startsWith(baseName) && f.name.includes('cover')
    )
    return coverFile ? 'video-cover' : 'video'
  }
  if (file.type === 'text') return 'text'
  return 'file'
}

/** 素材类型徽标文案（对照原版 renderDailyMaterials L2376-2380） */
export function assetTypeBadge(type: AssetFileType | string): { text: string; cls: string } {
  if (type === 'video') return { text: '视频', cls: 'video' }
  if (type === 'image') return { text: '图片', cls: 'image' }
  if (type === 'text') return { text: '图文', cls: 'text' }
  return { text: '文件', cls: 'file' }
}
