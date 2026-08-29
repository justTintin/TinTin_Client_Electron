// 一次性脚本：校验新产物 asar 内关键依赖齐全
const asar = require('@electron/asar')
const crypto = require('crypto')
const fs = require('fs')

const ap = process.argv[2] || '../dist-20260829-1918/win-unpacked/resources/app.asar'
const l = asar.listPackage(ap).map(f => f.split('\\').join('/'))
const must = [
  'process-nextick-args', 'core-util-is', 'isarray', 'bindings', 'sprintf-js',
  'semver', 'tar', 'jszip', 'unzipper', 'exceljs', 'docx', 'mammoth', 'adm-zip',
  'better-sqlite3', 'onnxruntime-node', 'onnxruntime-common', 'readable-stream'
]
let bad = 0
for (const m of must) {
  const hit = l.some(f => f.includes('/node_modules/' + m + '/'))
  if (!hit) { console.log('MISSING:', m); bad++ }
}
console.log(bad === 0 ? `all ${must.length} critical packages present` : `failures=${bad}`)
console.log('total files:', l.length)

const files = ['main/main.js', 'preload/preload.js', 'main/office-ipc.js', 'main/thickShell-ipc.js', 'main/server-proxy.js']
for (const f of files) {
  const b = asar.extractFile(ap, f)
  const a = crypto.createHash('sha256').update(b).digest('hex').slice(0, 12)
  const c = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12)
  console.log(f.padEnd(28), a === c ? 'MATCH' : 'DIFF')
}
