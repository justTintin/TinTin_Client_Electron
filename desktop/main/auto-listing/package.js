// ═══════════════════════════════════════════════════════════════
// auto-listing/package.js — B12 自动上架：数据包导入 → staging
// 对位：原 studio/utils/auto_listing/validation.py prepare_package
//   （L287-306）：目录复制 / zip 解压 → staging（PRD 14.6：每次任务
//   独立 run_id，runs/<runId>/input）。runId=时间戳（YYYYMMDD_HHMMSS）。
// ═══════════════════════════════════════════════════════════════
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const AdmZip = require('adm-zip')
const { ValidationError, inspectPackage } = require('./validate')

/** runId = 时间戳（对位原 datetime.now().strftime("%Y%m%d_%H%M%S")，PRD 14.6） */
function newRunId(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** staging 目录：<syncDir>/runs/<runId>/input */
function stagingDir(syncDir, runId) {
  return path.join(syncDir, 'runs', String(runId), 'input')
}

/** 目录递归复制（对位 shutil.copytree dirs_exist_ok=True） */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

/**
 * 数据包导入 + 校验（对位原 prepare_package）。
 * @param {string} inputPath 目录或 .zip
 * @param {string} shopKey 目标店铺键
 * @param {{syncDir: string, runId?: string}} opts
 * @returns {Promise<{info: PackageInfo, runId: string, sourceName: string}>}
 */
async function preparePackage(inputPath, shopKey, { syncDir, runId } = {}) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new ValidationError(`输入路径不存在: ${inputPath}`)
  }
  const sourceName = path.basename(inputPath.replace(/[\\/]+$/, ''))
  runId = runId || newRunId()
  const staged = stagingDir(syncDir, runId)
  fs.mkdirSync(staged, { recursive: true })

  if (fs.statSync(inputPath).isDirectory()) {
    copyDir(inputPath, staged)
  } else if (/\.zip$/i.test(inputPath)) {
    try {
      const zip = new AdmZip(inputPath)
      zip.extractAllTo(staged, true)
    } catch (e) {
      throw new ValidationError(`解压数据包失败: ${e.message || e}`)
    }
  } else {
    throw new ValidationError('输入必须是文件夹或 .zip 压缩包')
  }

  const info = await inspectPackage(staged, sourceName, shopKey)
  return { info, runId, sourceName }
}

module.exports = { newRunId, stagingDir, copyDir, preparePackage }
