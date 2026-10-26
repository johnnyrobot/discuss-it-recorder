// The demo as GitHub Pages hosts it: static files under a base path, such as
// https://johnnyrobot.github.io/discuss-it-recorder/. With no DEMO_URL it builds the site
// with scripts/build-demo.mjs and serves it under /discuss-it-recorder/ as Pages does; with
// DEMO_URL it checks that address instead. The page must show the recorder version, and a
// video take with Blur and an audio-only take must each record, finish, play back to the end
// and download. Every request must stay inside the site: any other is recorded and aborted,
// so even a failing run sends nothing out. Run `npm run build` first.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
let server
let site = process.env.DEMO_URL
if (!site) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discuss-it-site-'))
  assert.equal(spawnSync(process.execPath, ['scripts/build-demo.mjs', directory], { stdio: 'inherit' }).status, 0, 'scripts/build-demo.mjs failed')
  const base = '/discuss-it-recorder/'
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json' }
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    // As on Pages: the site's path without its slash redirects, and a directory serves its index.html.
    if (pathname === base.slice(0, -1)) { res.writeHead(301, { Location: base }); res.end(); return }
    let file = pathname.startsWith(base) && path.join(directory, decodeURIComponent(pathname.slice(base.length)))
    if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!file || !file.startsWith(directory + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  site = `http://127.0.0.1:${server.address().port}${base}`
}
const siteUrl = new URL(site.endsWith('/') ? site : `${site}/`)
const synthetic = process.env.BROWSER === 'webkit'
const blocked = []; const failed = []; const errors = []
const browser = synthetic ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true })
  // WebKit has no fake capture devices, so feed it a synthetic camera and microphone, on every
  // page the test opens. Replace capture on the prototype: WebKit can drop instance overrides.
  if (synthetic) {
    await context.addInitScript(() => {
      MediaDevices.prototype.getUserMedia = async function syntheticCapture (constraints) {
        const tracks = []
        if (constraints.video) {
          const source = document.createElement('canvas'); source.width = 640; source.height = 480
          const draw = () => { const ctx = source.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 320, 480); ctx.fillStyle = 'blue'; ctx.fillRect(320, 0, 320, 480) }
          draw(); setInterval(draw, 30)
          tracks.push(...source.captureStream(15).getVideoTracks())
        }
        const audio = new AudioContext(); const oscillator = audio.createOscillator(); const destination = audio.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start(); audio.resume()
        return new MediaStream([...tracks, ...destination.stream.getAudioTracks()])
      }
      MediaDevices.prototype.enumerateDevices = async () => []
    })
  }
  await context.route(url => !['data:', 'blob:'].includes(url.protocol), route => {
    const request = route.request(); const url = new URL(request.url())
    if (url.origin === siteUrl.origin && url.pathname.startsWith(siteUrl.pathname) && request.method() === 'GET') return route.continue()
    blocked.push(`${request.method()} ${request.url()}`)
    return route.abort()
  })
  context.on('response', response => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`) })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(siteUrl.href)

  const shown = await page.getByText(/^Recorder v/).innerText()
  assert.match(shown, new RegExp(`^Recorder v${version.replaceAll('.', '\\.')} · commit [0-9a-f]{7}$`), 'The page must show the recorder version and commit')
  if (!process.env.DEMO_URL) assert.ok(shown.endsWith(spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).stdout.trim()), `${shown} is not this checkout's commit`)

  const take = async audioOnly => {
    if (synthetic) assert.equal(await page.evaluate(() => navigator.mediaDevices.getUserMedia.name), 'syntheticCapture', 'Synthetic capture is not installed; refusing to open a real camera or microphone')
    if (!audioOnly) await page.getByRole('combobox', { name: /^Background/ }).selectOption('blur')
    await page.getByRole('button', { name: audioOnly ? 'Enable microphone' : 'Enable camera & microphone', exact: true }).click()
    await page.getByRole('button', { name: 'Start recording', exact: true }).click({ timeout: 60000 })
    await page.waitForTimeout(1600)
    await page.getByRole('button', { name: 'Stop & review', exact: true }).click()
    const link = page.getByRole('link', { name: 'Download a copy', exact: true })
    await link.waitFor({ timeout: 15000 })
    const played = await page.getByLabel('Review recording', { exact: true }).evaluate(media => new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error(`The review did not play to the end: ${media.currentTime} s of ${media.duration}`)), 15000)
      media.addEventListener('ended', () => resolve({ seconds: media.currentTime, width: media.videoWidth || 0 }), { once: true })
      media.muted = true
      media.play().catch(reject)
    }))
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
    const name = download.suggestedFilename()
    const bytes = fs.statSync(await download.path()).size
    assert.match(name, audioOnly ? /^my-recording\.(m4a|webm)$/ : /^my-recording\.(mp4|webm)$/)
    assert.ok(played.seconds > 1 && bytes > 1000 && (audioOnly || played.width > 0), `The ${audioOnly ? 'audio' : 'video'} take must play back and download: ${JSON.stringify({ ...played, name, bytes })}`)
    return `${name}, ${bytes} bytes, played ${played.seconds.toFixed(1)} s`
  }
  const video = await take(false)
  await page.getByRole('link', { name: 'Audio only', exact: true }).click()
  await page.waitForURL(url => url.searchParams.has('audio'))
  const audio = await take(true)

  assert.deepEqual(blocked, [], 'The demo must request nothing outside its own site')
  assert.deepEqual(failed, [], 'Every file the demo requests must load')
  assert.deepEqual(errors, [])
  console.log(`PASS the demo at ${siteUrl.href} (${process.env.BROWSER || 'chromium'}) shows "${shown}", records, plays back and downloads a video take (${video}) and an audio-only take (${audio}), with no request outside the site`)
} catch (error) {
  if (blocked.length || failed.length) console.log('Blocked requests:', blocked, '\nFailed requests:', failed)
  throw error
} finally { await browser.close(); server?.close() }
