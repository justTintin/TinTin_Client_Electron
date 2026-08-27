const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function getTimestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

const timestamp = getTimestamp()
const outputDir = `../dist-${timestamp}`
const cwd = path.resolve(__dirname, '..')
const electronDist = path.join(cwd, 'node_modules', 'electron', 'dist').replace(/\\/g, '/')

console.log(`📦 打包产物目录: ${outputDir}`)

const baseConfigPath = path.join(cwd, 'package.json')
const packageJson = JSON.parse(fs.readFileSync(baseConfigPath, 'utf-8'))
const buildConfig = packageJson.build

buildConfig.directories.output = outputDir
buildConfig.electronDist = electronDist

const configPath = path.join(cwd, `builder-timestamp-${timestamp}.json`)
fs.writeFileSync(configPath, JSON.stringify(buildConfig, null, 2))

console.log('🔨 开始打包...')
try {
  execSync(`npx electron-builder --win --x64 --dir -c "${configPath}"`, {
    cwd,
    stdio: 'inherit'
  })
  console.log(`\n✅ 打包完成: ${path.resolve(cwd, outputDir)}`)
} catch (e) {
  console.error('❌ 打包失败')
  process.exit(1)
} finally {
  fs.unlinkSync(configPath)
}
