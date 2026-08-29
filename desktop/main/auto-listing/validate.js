// ═══════════════════════════════════════════════════════════════
// auto-listing/validate.js — B12 自动上架：数据包结构校验 + sku.xlsx 解析
//
// 对位：原 studio/utils/auto_listing/validation.py（整文件逐段对照）：
//   normalize_name / shop_matches（L44-58）、_find_dir / _collect_images
//   （L61-85）、image_size（L88-114）、_read_excel（L117-208）、
//   _locate_working_dir（L211-218）、inspect_package（L221-284）。
// 纯函数优先（可脱离 electron 单测）；xlsx 解析用 exceljs（见选择说明）。
// ═══════════════════════════════════════════════════════════════
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const ExcelJS = require('exceljs')
const { DOUYIN_STORES } = require('./config')

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])

class ValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'ValidationError' }
}

class SkuRow {
  constructor(name, merchantCode = '') {
    this.name = name
    this.merchant_code = merchantCode
  }
}

/** PackageInfo 等价结构（对位原 dataclass L28-41） */
class PackageInfo {
  constructor(o) {
    this.working_dir = o.working_dir
    this.source_name = o.source_name
    this.shop_key = o.shop_key
    this.shop_name = o.shop_name
    this.title = o.title || ''
    this.brand = o.brand || ''
    this.model = o.model || ''
    this.manufacturer = o.manufacturer || ''
    this.skus = o.skus || []
    this.main_images = o.main_images || []
    this.detail_images = o.detail_images || []
    this.sku_images = o.sku_images || []
    this.warnings = o.warnings || []
  }
}

/** 名称归一化：仅保留中文/字母/数字并小写（对位原 normalize_name L44-45） */
function normalizeName(name) {
  return String(name || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase()
}

/** 数据包名是否匹配目标店铺（对位原 shop_matches L48-58） */
function shopMatches(name, shopKey) {
  const info = DOUYIN_STORES[shopKey]
  if (!info) return false
  const cand = normalizeName(name)
  const shopNorm = normalizeName(info.name || '')
  if (shopNorm && (cand.includes(shopNorm) || shopNorm.includes(cand))) return true
  return (info.aliases || []).some((a) => {
    const na = normalizeName(a)
    return !!na && (cand.includes(na) || na.includes(cand))
  })
}

/** 在 base 下查找 wanted 目录（直接子目录优先，否则递归，对位原 _find_dir L61-70） */
function findDir(base, wanted) {
  if (!base || !fs.existsSync(base) || !fs.statSync(base).isDirectory()) return ''
  const direct = path.join(base, wanted)
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === wanted) return path.join(base, entry.name)
    }
  } catch (_) { /* 目录扫描失败 */ }
  // 递归一层层找（对位 os.walk 语义）
  try {
    const stack = [base]
    while (stack.length) {
      const dir = stack.pop()
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { continue }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === wanted) return path.join(dir, entry.name)
        stack.push(path.join(dir, entry.name))
      }
    }
  } catch (_) { /* 递归扫描失败 */ }
  return ''
}

/** 收集目录内图片：按 (数字序号, 文件名) 排序（对位原 _collect_images L73-85） */
function collectImages(directory) {
  if (!directory || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return []
  const indexOf = (p) => {
    const base = path.basename(p).replace(/\.[^.]+$/, '')
    const m = base.match(/(\d+)/)
    return m ? parseInt(m[1], 10) : 1e9
  }
  let files = []
  try {
    files = fs.readdirSync(directory)
      .filter((n) => IMAGE_EXTS.has(path.extname(n).toLowerCase()))
      .map((n) => path.join(directory, n))
  } catch (_) { return [] }
  files.sort((a, b) => {
    const ai = indexOf(a)
    const bi = indexOf(b)
    if (ai !== bi) return ai - bi
    return path.basename(a).toLowerCase() < path.basename(b).toLowerCase() ? -1 : 1
  })
  return files
}

/** 读取 PNG/JPG 宽高（无第三方依赖，对位原 image_size L88-114）；失败返回 null */
function imageSize(p) {
  try {
    const fd = fs.openSync(p, 'r')
    const buf = Buffer.alloc(32)
    fs.readSync(fd, buf, 0, 32, 0)
    fs.closeSync(fd)
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let pos = 2
      while (pos + 4 < buf.length) {
        if (buf[pos] !== 0xff) { pos += 1; continue }
        const marker = buf[pos + 1]
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          const h = buf.readUInt16BE(pos + 5)
          const w = buf.readUInt16BE(pos + 7)
          return [w, h]
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { pos += 2; continue }
        const len = buf.readUInt16BE(pos + 2)
        pos += 2 + len
      }
    }
  } catch (_) { /* 二进制解析失败 */ }
  return null
}

/** 列名候选匹配（对位原 col() L135-140）：表头小写包含或相等 */
function _colIndex(headers, candidates) {
  for (const cand of candidates) {
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i]
      if (h && (h.toLowerCase() === cand.toLowerCase() || cand.toLowerCase().includes(h.toLowerCase()))) return i
    }
  }
  return -1
}

/**
 * 解析 sku.xlsx（对位原 _read_excel L117-208）：
 *   sheet1：sku图片名/品牌/修改后的商品编码/商品标题/型号/生产厂家
 *   sheet2：字段/值（标题在 B1 或 B2）
 * @returns {{title, brand, model, manufacturer, skus: SkuRow[]}}
 */
async function readExcel(workingDir) {
  const xlsPath = path.join(workingDir, 'sku.xlsx')
  if (!fs.existsSync(xlsPath)) throw new ValidationError(`数据包缺少 sku.xlsx: ${workingDir}`)
  let wb
  try {
    wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(xlsPath)
  } catch (e) {
    throw new ValidationError(`读取 sku.xlsx 失败: ${e.message || e}`)
  }
  if (!wb.worksheets || wb.worksheets.length === 0) throw new ValidationError('sku.xlsx 没有任何工作表')

  const sheet1 = wb.worksheets[0]
  const headers = []
  const row1 = sheet1.getRow(1)
  for (let c = 1; c <= row1.cellCount; c++) {
    const v = row1.getCell(c).value
    headers.push(v === null || v === undefined ? '' : String(v).trim())
  }
  const rows = []
  sheet1.eachRow((row, rowNumber) => {
    if (rowNumber <= 1) return
    const values = []
    for (let c = 1; c <= row.cellCount; c++) {
      const v = row.getCell(c).value
      values.push(v && typeof v === 'object' && v.result !== undefined ? v.result : v)
    }
    rows.push(values)
  })

  const skuCol = _colIndex(headers, ['sku图片名', '组合装名称', 'SKU'])
  const brandCol = _colIndex(headers, ['品牌'])
  const merchantCol = _colIndex(headers, ['修改后的商品编码', '同步后的商家编码', '商家编码'])
  const titleCol = _colIndex(headers, ['商品标题', '标题'])
  const modelCol = _colIndex(headers, ['型号'])
  const manufacturerCol = _colIndex(headers, ['生产厂家', '生产厂商'])

  let brand = ''
  for (const values of rows) {
    if (brandCol >= 0 && values[brandCol] !== null && values[brandCol] !== undefined) {
      brand = String(values[brandCol]).trim()
      if (brand && brand.toLowerCase() !== 'nan') break
    }
  }

  const skus = []
  if (skuCol >= 0) {
    for (const values of rows) {
      if (values[skuCol] === null || values[skuCol] === undefined) continue
      const name = String(values[skuCol]).trim().replace(/\s+/g, ' ')
      if (!name || name.toLowerCase() === 'nan') continue
      let code = ''
      if (merchantCol >= 0 && values[merchantCol] !== null && values[merchantCol] !== undefined) {
        code = String(values[merchantCol]).trim()
      }
      if (!skus.some((s) => s.name === name)) skus.push(new SkuRow(name, code))
    }
  }

  let title = ''
  let model = ''
  let manufacturer = ''
  const kv = {}
  if (wb.worksheets.length > 1) {
    const sheet2 = wb.worksheets[1]
    const rows2 = []
    sheet2.eachRow((row) => {
      const values = []
      for (let c = 1; c <= row.cellCount; c++) {
        const v = row.getCell(c).value
        values.push(v && typeof v === 'object' && v.result !== undefined ? v.result : v)
      }
      rows2.push(values)
    })
    if (rows2.length) {
      const h2 = rows2[0].length > 1 ? String(rows2[0][1] || '').trim() : ''
      if (h2 && !h2.toLowerCase().startsWith('unnamed')) title = h2
      else if (rows2.length > 1 && rows2[1].length > 1 && rows2[1][1] !== null && rows2[1][1] !== undefined) {
        title = String(rows2[1][1]).trim()
      }
      for (let i = 1; i < rows2.length; i++) {
        const values = rows2[i]
        if (values.length >= 2 && values[0] !== null && values[0] !== undefined && values[1] !== null && values[1] !== undefined) {
          const key = String(values[0]).trim()
          const val = String(values[1]).trim()
          if (key && val && val.toLowerCase() !== 'nan') kv[key] = val
        }
      }
    }
  }

  if (!title && titleCol >= 0) {
    for (const values of rows) {
      if (values[titleCol] !== null && values[titleCol] !== undefined) {
        title = String(values[titleCol]).trim()
        if (title) break
      }
    }
  }

  model = kv['型号'] || ''
  manufacturer = kv['生产厂家'] || kv['生产厂商'] || ''
  if (!model && modelCol >= 0) {
    for (const values of rows) {
      if (values[modelCol] !== null && values[modelCol] !== undefined) {
        model = String(values[modelCol]).trim()
        break
      }
    }
  }
  if (!manufacturer && manufacturerCol >= 0) {
    for (const values of rows) {
      if (values[manufacturerCol] !== null && values[manufacturerCol] !== undefined) {
        manufacturer = String(values[manufacturerCol]).trim()
        break
      }
    }
  }
  return { title, brand, model, manufacturer, skus }
}

/** 在 base 下定位含 sku.xlsx 的工作目录（对位原 _locate_working_dir L211-218） */
function locateWorkingDir(base) {
  if (fs.existsSync(path.join(base, 'sku.xlsx'))) return base
  try {
    const stack = [base]
    while (stack.length) {
      const dir = stack.pop()
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { continue }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const p = path.join(dir, entry.name)
        if (fs.existsSync(path.join(p, 'sku.xlsx'))) return p
        stack.push(p)
      }
    }
  } catch (_) { /* 递归定位失败 */ }
  return base
}

/**
 * 数据包结构校验（对位原 inspect_package L221-284）。
 * @param {string} workingDir staging 目录（含 sku.xlsx）
 * @param {string} sourceName 数据包原始名（店铺关键词校验用）
 * @param {string} shopKey 目标店铺键
 * @returns {Promise<PackageInfo>}
 */
async function inspectPackage(workingDir, sourceName, shopKey) {
  workingDir = locateWorkingDir(workingDir)
  if (!fs.existsSync(path.join(workingDir, 'sku.xlsx'))) {
    throw new ValidationError(`数据包中未找到 sku.xlsx: ${workingDir}`)
  }
  if (!shopMatches(sourceName, shopKey)) {
    const info = DOUYIN_STORES[shopKey] || {}
    const expected = [info.name, ...(info.aliases || [])].filter(Boolean).join(' / ')
    throw new ValidationError(`数据包名称“${sourceName}”未包含目标店铺关键词，请包含：${expected}`)
  }

  const mainDir = findDir(workingDir, '主图')
  const detailDir = findDir(workingDir, '详情页') || findDir(workingDir, '详情')
  const skuDir = findDir(workingDir, 'sku图')
  const mainImages = collectImages(mainDir)
  const detailImages = collectImages(detailDir)
  const skuImages = collectImages(skuDir)

  const missing = []
  if (!mainImages.length) missing.push('主图')
  if (!detailImages.length) missing.push('详情页')
  if (!skuImages.length) missing.push('sku图')
  if (missing.length) throw new ValidationError(`数据包缺少可上传图片目录：${missing.join('、')}`)

  const nonSquare = []
  for (const p of mainImages) {
    const size = imageSize(p)
    if (size && size[0] !== size[1]) nonSquare.push(path.basename(p))
  }
  if (nonSquare.length) {
    throw new ValidationError(`主图必须为 1:1，以下文件不是正方形：${nonSquare.slice(0, 5).join(', ')}`)
  }

  const excel = await readExcel(workingDir)
  const skus = excel.skus
  if (!skus.length) {
    throw new ValidationError('sku.xlsx 未解析到任何 SKU/规格行（需要 sku图片名 或 组合装名称 列）')
  }

  const warnings = []
  if (!excel.title) warnings.push('未解析到商品标题，发布时可能跳过标题填写')
  if (!excel.brand) excel.brand = '无品牌'

  const infoData = DOUYIN_STORES[shopKey] || {}
  return new PackageInfo({
    working_dir: workingDir,
    source_name: sourceName,
    shop_key: shopKey,
    shop_name: String(infoData.name || shopKey),
    title: excel.title,
    brand: excel.brand,
    model: excel.model,
    manufacturer: excel.manufacturer,
    skus,
    main_images: mainImages,
    detail_images: detailImages,
    sku_images: skuImages,
    warnings,
  })
}

module.exports = {
  ValidationError,
  SkuRow,
  PackageInfo,
  IMAGE_EXTS,
  normalizeName,
  shopMatches,
  findDir,
  collectImages,
  imageSize,
  readExcel,
  locateWorkingDir,
  inspectPackage,
}
