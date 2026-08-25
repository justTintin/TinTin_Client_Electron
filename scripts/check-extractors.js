// 一次性验证脚本：模拟 thickShell-ipc.js 的 extractor 拼接逻辑，对 5 平台产物做 node --check
// 用法：node scripts/check-extractors.js   （验证完成后可删除本文件）
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const dir = path.resolve(__dirname, '..', 'electron', 'main', 'extractors')
const platforms = ['douyin', 'weixin', 'kuaishou', 'xiaohongshu', 'bilibili']
const tmpDir = path.join(require('os').tmpdir(), 'tintin-extractor-check')

fs.mkdirSync(tmpDir, { recursive: true })

const common = fs.readFileSync(path.join(dir, '_common.ts'), 'utf8')
let failed = 0

for (const p of platforms) {
  const script = fs.readFileSync(path.join(dir, `${p}.ts`), 'utf8')
  const combined = common + '\n' + script
  const wrapped = `(function(){\n  try { ${combined} }\n  catch(e){ return { ok:false, error:{type:'DOM_MISMATCH', message:String(e.message||e), hint:'平台DOM可能已变更'} } }\n})()`
  const outFile = path.join(tmpDir, `${p}.check.js`)
  fs.writeFileSync(outFile, wrapped, 'utf8')
  try {
    execFileSync(process.execPath, ['--check', outFile], { stdio: 'pipe' })
    console.log(`PASS  ${p}.ts  (拼接产物 ${Math.round(wrapped.length / 1024)}KB，语法合法)`)
  } catch (e) {
    failed++
    console.error(`FAIL  ${p}.ts`)
    console.error(String(e.stderr || e.message))
  }
}

if (failed > 0) {
  console.error(`\n${failed} 个平台脚本语法检查失败`)
  process.exit(1)
}
console.log('\n全部 5 个平台 extractor 拼接产物语法验证通过')
