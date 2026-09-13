// 临时探针（用完即删）：POST /matting 响应形态鉴别
const http = require('http')
const fs = require('fs')

const img = fs.readFileSync('d:/Project/TinTin_Client_Electron/test/exe-icon-check.png')
const b = '----Probe' + Math.random().toString(16).slice(2)
const parts = []
parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="t.png"\r\nContent-Type: image/png\r\n\r\n`, 'utf8'), img, Buffer.from('\r\n'))
parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="model"\r\n\r\nu2net\r\n`))
parts.push(Buffer.from(`--${b}--\r\n`))
const body = Buffer.concat(parts)

const req = http.request(
  { hostname: '192.168.111.31', port: 8000, path: '/matting', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + b, 'Content-Length': body.length } },
  (r) => {
    const chunks = []
    r.on('data', (c) => chunks.push(c))
    r.on('end', () => {
      const buf = Buffer.concat(chunks)
      console.log('status', r.statusCode, 'ct', r.headers['content-type'], 'len', buf.length)
      const head = buf.slice(0, 120).toString('utf8').replace(/[^\x20-\x7e]/g, '.')
      console.log('head:', head)
      console.log('isPNG(binary):', buf.slice(1, 4).toString() === 'PNG')
    })
  },
)
req.on('error', (e) => console.log('ERR', e.message))
req.end(body)
