// Local-only development demo. No login, API, upload or persistent storage.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { pages, source } from './demo-site.mjs'
const root = process.cwd()
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.wasm': 'application/wasm' }
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const sitePath = pathname === '/' ? 'index.html' : pathname.slice(1)
  if (Object.hasOwn(pages, sitePath)) { res.setHeader('Content-Type', types[path.extname(sitePath)]); res.end(pages[sitePath]); return }
  const relative = source(sitePath)
  const file = relative && path.resolve(root, relative)
  if (!file || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream')
  fs.createReadStream(file).pipe(res)
})
server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log(`Recorder demo: http://127.0.0.1:${server.address().port}`))
export default server
