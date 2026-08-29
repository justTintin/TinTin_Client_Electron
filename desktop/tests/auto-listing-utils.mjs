// ═══════════════════════════════════════════════════════════════
// auto-listing-utils.mjs — B12 自动上架单测共享 fixture 构建
//   · PNG/JPG 二进制头生成（1:1 / 非 1:1，无需图像库）
//   · 数据包目录 fixture（主图/详情页/sku图 + sku.xlsx 两 sheet）
//   · zip 打包（adm-zip，与 package.js 同源）
// ═══════════════════════════════════════════════════════════════
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import AdmZip from 'adm-zip'

/** 最小 PNG 头（前 24 字节即可被 imageSize 解析） */
export function pngBytes(w, h) {
  const buf = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'utf8')
  buf.writeUInt32BE(w, 16)
  buf.writeUInt32BE(h, 20)
  return buf
}

/** 最小 JPG 头（APP0 + SOF0 + EOI，可被 imageSize 解析出宽高） */
export function jpgBytes(w, h) {
  const app0 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof = Buffer.alloc(10)
  sof[0] = 0xff; sof[1] = 0xc0
  sof.writeUInt16BE(8, 2)
  sof[4] = 8
  sof.writeUInt16BE(h, 5)
  sof.writeUInt16BE(w, 7)
  sof[9] = 3
  return Buffer.concat([app0, sof, Buffer.from([0xff, 0xd9])])
}

/** 写 sku.xlsx：sheet1 规格行 + sheet2 字段/值（对位原 _read_excel 两 sheet 解析） */
export async function writeSkuXlsx(file) {
  const wb = new ExcelJS.Workbook()
  const s1 = wb.addWorksheet('Sheet1')
  s1.addRow(['sku图片名', '品牌', '修改后的商品编码', '商品标题', '型号', '生产厂家'])
  s1.addRow(['A款', '桔柚', 'P001', '', 'A1', ''])
  s1.addRow(['B款', '', 'P002', '', 'B2', ''])
  const s2 = wb.addWorksheet('Sheet2')
  s2.addRow(['标题', '桔柚电池测试标题'])
  s2.addRow(['型号', 'X100'])
  s2.addRow(['生产厂家', '测试厂'])
  await wb.xlsx.writeFile(file)
}

/**
 * 构建数据包目录 fixture。
 * @param {string} base 临时根
 * @param {{name?: string, mainW?: number, mainH?: number, skipSkuImages?: boolean}} [opts]
 * @returns {Promise<string>} 数据包根目录
 */
export async function buildPackageFixture(base, opts = {}) {
  const root = join(base, opts.name || '桔柚数据包')
  mkdirSync(join(root, '主图'), { recursive: true })
  mkdirSync(join(root, '详情页'), { recursive: true })
  if (!opts.skipSkuImages) mkdirSync(join(root, 'sku图'), { recursive: true })
  const mw = opts.mainW || 10
  const mh = opts.mainH || 10
  writeFileSync(join(root, '主图', '1.png'), pngBytes(mw, mh))
  writeFileSync(join(root, '主图', '2.jpg'), jpgBytes(mw, mh))
  writeFileSync(join(root, '详情页', '1.png'), pngBytes(10, 10))
  if (!opts.skipSkuImages) {
    writeFileSync(join(root, 'sku图', 'A款.png'), pngBytes(10, 10))
    writeFileSync(join(root, 'sku图', 'B款.png'), pngBytes(10, 10))
  }
  await writeSkuXlsx(join(root, 'sku.xlsx'))
  return root
}

/** 将目录打成 zip（文件名需含店铺关键词，对位店铺命名校验） */
export function zipFolder(srcDir, zipPath, namePrefix = '桔柚') {
  const zip = new AdmZip()
  zip.addLocalFolder(srcDir, '')
  zip.writeZip(zipPath)
  return zipPath
}
