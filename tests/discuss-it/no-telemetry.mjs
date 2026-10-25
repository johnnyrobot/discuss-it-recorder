// No telemetry (docs/adr/0001-no-telemetry.md): the recorder stays on MediaPipe Tasks Vision
// 0.10.x, because 1.x POSTs usage metrics to Google, and serves every model and WASM file
// itself. This fails if the pin drifts or a file a host ships names a telemetry or analytics
// endpoint. It reads the assets `npm run build` staged, so build first.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const root = process.cwd()
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const pin = JSON.parse(read('package.json')).dependencies['@mediapipe/tasks-vision']
assert.match(pin, /^0\.10\.\d+$/, `@mediapipe/tasks-vision must be pinned to an exact 0.10.x release, not ${pin}: 1.x sends usage metrics to Google`)
assert.equal(JSON.parse(read('package-lock.json')).packages['node_modules/@mediapipe/tasks-vision'].version, pin, 'package-lock.json must lock the pinned @mediapipe/tasks-vision')
const assets = 'public/assets/discuss-it'
assert.ok(fs.existsSync(path.join(root, assets, 'manifest.json')), 'No staged assets: run npm run build first')
assert.equal(JSON.parse(read(`${assets}/manifest.json`)).version, pin, 'The staged MediaPipe assets are not the pinned release: run npm run build')
const endpoints = [
  /x-goog-api-key/i, // the header MediaPipe 1.x sends its logging key in
  /google-analytics\.com|googletagmanager\.com|doubleclick\.net/i,
  /firebaselogging|clearcut/i // Google's logging pipelines
]
const files = []
const walk = directory => {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(file); else files.push(file)
  }
}
walk(assets); walk('resources/js')
const found = []
for (const file of files) {
  const text = fs.readFileSync(path.join(root, file), 'latin1')
  // type.googleapis.com only prefixes protobuf type names; no code calls it. Any other
  // Google API host, such as odml.pa.googleapis.com for MediaPipe's usage logging, fails.
  for (const host of text.match(/[a-z0-9.-]*googleapis\.com/gi) || []) if (host.toLowerCase() !== 'type.googleapis.com') found.push(`${file}: ${host}`)
  for (const endpoint of endpoints) { const match = text.match(endpoint); if (match) found.push(`${file}: ${match[0]}`) }
}
assert.deepEqual(found, [], 'A shipped file names a telemetry or analytics endpoint')
console.log(`PASS no telemetry endpoints in ${files.length} shipped files (@mediapipe/tasks-vision ${pin})`)
