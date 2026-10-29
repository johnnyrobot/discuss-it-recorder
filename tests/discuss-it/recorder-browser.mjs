// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright index.mjs.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const root = process.cwd()
// Chromium's default fake camera has no fixed left and right, so it plays this one-frame
// Y4M file on a loop instead: red left, blue right, like WebKit's synthetic camera below.
// I420 planes use BT.601 limited range: red is Y 81, U 90, V 240; blue is Y 41, U 240, V 110.
function splitCameraFrame (width = 640, height = 480) {
  const plane = (w, h, left, right) => {
    const bytes = Buffer.alloc(w * h, right)
    for (let y = 0; y < h; y++) bytes.fill(left, y * w, y * w + w / 2)
    return bytes
  }
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\nFRAME\n`),
    plane(width, height, 81, 41), plane(width / 2, height / 2, 90, 240), plane(width / 2, height / 2, 240, 110)])
}
const cameraDirectory = process.env.BROWSER === 'webkit' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'discuss-it-camera-'))
const cameraFile = cameraDirectory && path.join(cameraDirectory, 'split.y4m')
if (cameraFile) {
  process.on('exit', () => fs.rmSync(cameraDirectory, { recursive: true, force: true }))
  fs.writeFileSync(cameraFile, splitCameraFrame())
}
// Runtime assets are served only from a non-default directory, so a hard-coded
// /assets/discuss-it/ path anywhere in the recorder fails this test. The worker is
// served from source, not the built copy, so an unbuilt edit is still what is tested.
const assetDirectory = '/static/recorder/'
// CROSS_ORIGIN=1 serves the assets only from a second local origin, as a host's own asset
// CDN would, with CORS headers. A copy under /no-cors/ on that origin sends none.
const crossOrigin = process.env.CROSS_ORIGIN === '1'
// iPhone mode uses the main thread by design, and FAIL_WORKER removes the worker.
const expectWorker = process.env.IPHONE !== '1' && process.env.FAIL_WORKER !== '1'
const send = (res, source) => {
  if (!source.startsWith(root) || !fs.existsSync(source) || !fs.statSync(source).isFile()) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', /\.m?js$/.test(source) ? 'application/javascript' : source.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
  fs.createReadStream(source).pipe(res)
}
const assetSource = url => url === `${assetDirectory}segmenter-worker.js` ? path.join(root, 'resources/js/media/recording/segmenter-worker.js')
  : url.startsWith(assetDirectory) ? path.join(root, 'public/assets/discuss-it', url.slice(assetDirectory.length)) : ''
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    // With assets on another origin, the page allows only what docs/INTERFACE.md tells hosts to.
    if (crossOrigin) res.setHeader('Content-Security-Policy', `script-src 'self' ${assetOrigin} 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' ${assetOrigin}`)
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width"><canvas id="preview"></canvas>'); return
  }
  const url = req.url.split('?')[0]
  send(res, ['/Recorder.js', '/BackgroundProcessor.js', '/BackgroundImage.js'].includes(url) ? path.join(root, 'resources/js/media/recording', url.slice(1))
    : crossOrigin ? '' : assetSource(url))
})
const assetServer = crossOrigin && http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (url.startsWith('/no-cors/')) { send(res, assetSource(url.slice('/no-cors'.length))); return }
  res.setHeader('Access-Control-Allow-Origin', '*')
  send(res, assetSource(url))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
if (assetServer) await new Promise(resolve => assetServer.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const assetOrigin = assetServer ? `http://127.0.0.1:${assetServer.address().port}` : origin
const assetBase = crossOrigin ? `${assetOrigin}${assetDirectory}` : assetDirectory
const noCorsBase = crossOrigin ? `${assetOrigin}/no-cors${assetDirectory}` : null
const browser = process.env.BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${cameraFile}`] })
const watchdog = setTimeout(async () => { console.error('Browser test timed out'); await browser.close() }, 90000)
const backgrounds = process.env.BACKGROUND ? [process.env.BACKGROUND] : ['none', 'color', 'blur', 'image']
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    ...(process.env.IPHONE === '1' ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1' } : {}) })
  const errors = []
  page.on('console', message => console.log('browser:', message.text()))
  page.on('pageerror', error => errors.push(error.message))
  // No telemetry (docs/adr/0001-no-telemetry.md): the recorder may request nothing from an
  // origin other than the page's and the host's asset origin, and uploads nothing anywhere:
  // it only fetches its own files. Other requests are recorded and aborted, so even a failing
  // run sends nothing out.
  const offsite = []
  const uploads = []
  await page.context().route(url => !['data:', 'blob:'].includes(url.protocol), route => {
    const request = route.request()
    if (![origin, assetOrigin].includes(new URL(request.url()).origin)) offsite.push(request.url())
    else if (request.method() !== 'GET') uploads.push(`${request.method()} ${request.url()}`)
    else return route.continue()
    return route.abort()
  })
  await page.goto(origin)
  if (process.env.FAIL_WORKER === '1') await page.evaluate(() => { window.Worker = class { constructor () { throw new Error('Injected worker-unavailable condition') } } })
  // Replace capture methods on the prototype: WebKit can garbage-collect the
  // navigator.mediaDevices wrapper and drop instance overrides, which would make
  // a later call open the real camera and microphone.
  if (process.env.FAIL_ENUMERATION === '1') await page.evaluate(() => { MediaDevices.prototype.enumerateDevices = async () => { throw new Error('Injected enumeration denial') } })
  if (process.env.BROWSER === 'webkit') {
    // WebKit has no fake capture devices, so feed it a synthetic camera and microphone.
    await page.evaluate(() => {
      const source = document.createElement('canvas'); source.width = 640; source.height = 480; document.body.appendChild(source)
      const draw = () => { const ctx = source.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 320, 480); ctx.fillStyle = 'blue'; ctx.fillRect(320, 0, 320, 480) }
      draw(); setInterval(draw, 30)
      const video = source.captureStream(15)
      const audio = new AudioContext(); const oscillator = audio.createOscillator(); const destination = audio.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start(); audio.resume()
      MediaDevices.prototype.getUserMedia = async function syntheticCapture (constraints) {
        return new MediaStream([...(constraints.video ? video.getVideoTracks().map(track => track.clone()) : []), ...destination.stream.getAudioTracks().map(track => track.clone())])
      }
      MediaDevices.prototype.enumerateDevices = async () => []
    })
  }
  const result = await page.evaluate(async ({ backgrounds, assetBase, synthetic, expectWorker }) => {
    if (synthetic && navigator.mediaDevices.getUserMedia.name !== 'syntheticCapture') throw Error('Synthetic capture is not installed; refusing to open a real camera or microphone')
    const { default: Recorder, extensionFor, recordingFormat } = await import('/Recorder.js')
    // An unset assetBase (Vue passes null for an unset String prop) means the default
    // directory. A query string or fragment cannot apply to MediaPipe's WASM directory.
    const { default: BackgroundProcessor } = await import('/BackgroundProcessor.js')
    for (const [base, expected] of [[undefined, '/assets/discuss-it/'], [null, '/assets/discuss-it/'], ['', '/assets/discuss-it/'], ['/static/recorder', '/static/recorder/'], ['/static/recorder/?v=3#top', '/static/recorder/']]) {
      const assets = new BackgroundProcessor(base).assets
      if (assets !== location.origin + expected) throw Error(`assetBase ${JSON.stringify(base)} resolved to ${assets}`)
    }
    console.log('PASS assetBase defaults and normalization')
    const prepareWorker = Recorder.prototype.prepareWorker
    Recorder.prototype.prepareWorker = async function () { console.log('loading segmenter'); await prepareWorker.call(this); console.log('segmenter loaded') }
    if (extensionFor('video/mp4') !== 'mp4' || extensionFor('audio/mp4') !== 'm4a') throw Error('Format mapping failed')
    const canvas = document.querySelector('canvas')
    const states = []
    const errors = []
    let recorder
    const tests = []
    const backgroundCanvas = document.createElement('canvas'); backgroundCanvas.width = 640; backgroundCanvas.height = 480
    const backgroundContext = backgroundCanvas.getContext('2d'); backgroundContext.fillStyle = '#ff0080'; backgroundContext.fillRect(0, 0, 640, 480)
    const image = await new Promise(resolve => backgroundCanvas.toBlob(resolve, 'image/png'))
    for (const background of backgrounds) {
      console.log('preparing', background)
      recorder = new Recorder(canvas, state => states.push(state), error => errors.push(error.message), { assetBase })
      await recorder.prepare({ background, mirror: true, image })
      console.log('preview', background)
      if (recorder.state !== 'preview') throw Error('No preview')
      const complete = recorder.start()
      await new Promise(resolve => setTimeout(resolve, 2200))
      recorder.stop()
      const clip = await complete
      console.log('recorded', background)
      recorder.dispose()
      if (clip.blob.size < 1000 || clip.durationMs < 2000) throw Error('Invalid clip')
      const player = document.createElement('video')
      player.src = URL.createObjectURL(clip.blob); player.muted = true
      await Promise.race([player.play(), new Promise((resolve, reject) => setTimeout(() => reject(Error('Playback timed out')), 10000))])
      if (!player.videoWidth) throw Error('Recorded clip cannot play')
      if (background === 'none') {
        // Inspect encoded playback, not the preview: both browsers' test cameras are
        // red-left, blue-right, so a saved mirrored clip must be blue-left, red-right.
        // play() can resolve before WebKit has decoded a frame it can draw, and drawing then
        // leaves the canvas transparent, so sample once the player presents its next frame.
        await Promise.race([new Promise(resolve => player.requestVideoFrameCallback(() => resolve())),
          new Promise((resolve, reject) => setTimeout(() => reject(Error('Recorded clip presented no frame')), 5000))])
        const pixels = document.createElement('canvas'); pixels.width = 640; pixels.height = 480
        const context = pixels.getContext('2d', { willReadFrequently: true }); context.drawImage(player, 0, 0, 640, 480)
        const left = context.getImageData(100, 240, 1, 1).data
        const right = context.getImageData(540, 240, 1, 1).data
        const pixelText = `(left ${left}, right ${right})`
        if (left[3] !== 255 || right[3] !== 255) throw Error(`Saved video had no frame to sample ${pixelText}`)
        if (!(left[2] > left[0] + 100 && right[0] > right[2] + 100)) throw Error(`Saved video is not mirrored ${pixelText}`)
        console.log('PASS encoded video pixels are mirrored')
      }
      player.pause(); URL.revokeObjectURL(player.src)
      tests.push({ background, bytes: clip.blob.size, type: clip.mimeType, width: player.videoWidth })
    }
    // stop() never returns another session's take; a failed start keeps the preview;
    // disposing during a take rejects it instead of resolving with a clip.
    recorder = new Recorder(canvas, state => states.push(state), error => errors.push(error.message), { assetBase })
    let noTake = false
    try { await recorder.stop() } catch (error) { noTake = error.name === 'InvalidStateError' }
    await recorder.prepare({ background: 'none' })
    const earlier = recorder.start()
    await new Promise(resolve => setTimeout(resolve, 600))
    recorder.stop(); await earlier
    await recorder.prepare({ background: 'none' })
    try { await recorder.stop(); noTake = false } catch (error) { noTake = noTake && error.name === 'InvalidStateError' }
    if (!noTake) throw Error('stop() without a take in progress must reject, not return an earlier take')
    const captureStream = HTMLCanvasElement.prototype.captureStream
    const startRecorder = MediaRecorder.prototype.start
    let captured = []
    HTMLCanvasElement.prototype.captureStream = function (...args) { const stream = captureStream.apply(this, args); captured = stream.getVideoTracks(); return stream }
    MediaRecorder.prototype.start = function () { throw new DOMException('Injected start failure', 'NotSupportedError') }
    let startFailed = false
    try { recorder.start() } catch (error) { startFailed = error.name === 'NotSupportedError' }
    HTMLCanvasElement.prototype.captureStream = captureStream
    MediaRecorder.prototype.start = startRecorder
    if (!startFailed || recorder.state !== 'preview' || recorder.output || !captured.length || captured.some(track => track.readyState !== 'ended')) throw Error('A failed start must keep the preview and stop its canvas capture')
    if (!recorder.stream.getTracks().every(track => track.readyState === 'live')) throw Error('A failed start must keep the camera')
    const abandoned = recorder.start()
    await new Promise(resolve => setTimeout(resolve, 1200))
    recorder.dispose()
    let aborted = false
    try { await abandoned } catch (error) { aborted = error.name === 'AbortError' }
    if (!aborted) throw Error('Disposing during a take must reject it with AbortError, not resolve with a clip')
    console.log('PASS stop() before a take, failed start and disposal during a take')
    // Where the worker should run, falling back to the main thread is a failure, not a
    // skip. The query string checks that it still starts from a cache-busted assetBase.
    const takeErrors = []
    recorder = new Recorder(canvas, state => states.push(state), error => takeErrors.push(error.message), { assetBase: `${assetBase}?v=3` })
    await recorder.prepare({ background: 'blur' })
    if (!recorder.processor.worker) {
      if (expectWorker) throw Error('The segmenter worker did not start from assetBase')
      console.log('SKIP worker failures: this mode does not use a worker')
    } else {
      // A worker that fails mid-take ends the take with one explanation instead of
      // freezing the picture while the model reloads on the main thread. Delaying the
      // stop event lets frames be drawn after the failure, as a slow device would.
      const take = recorder.start()
      const mediaRecorder = recorder.recorder
      const stopMediaRecorder = mediaRecorder.stop.bind(mediaRecorder)
      mediaRecorder.stop = () => setTimeout(stopMediaRecorder, 400)
      await new Promise(resolve => setTimeout(resolve, 800))
      recorder.processor.request = () => Promise.reject(new Error('Injected worker crash'))
      const clip = await take
      if (recorder.state !== 'review' || !clip.blob.size) throw Error('A worker failure must end the take with the clip so far')
      if (takeErrors.length !== 1 || !takeErrors[0].includes('stopped responding')) throw Error(`A worker failure must explain once why recording stopped (${takeErrors})`)
      console.log('PASS worker failure during a take stops it with one explanation')
      recorder.dispose()
      // A frame request sent in preview that fails after Start must stop the take too,
      // not reload the model on the main thread while recording.
      takeErrors.length = 0
      recorder = new Recorder(canvas, state => states.push(state), error => takeErrors.push(error.message), { assetBase })
      await recorder.prepare({ background: 'blur' })
      let reloaded = false
      recorder.processor.initMain = async () => { reloaded = true }
      const requested = new Promise(resolve => {
        recorder.processor.request = () => { resolve(); return new Promise((_, reject) => setTimeout(() => reject(new Error('Injected timeout')), 1000)) }
      })
      await requested
      const late = await recorder.start()
      if (reloaded || takeErrors.length !== 1 || !takeErrors[0].includes('stopped responding') || !late.blob.size) throw Error(`A preview request that fails during a take must stop it (${takeErrors}; reloaded: ${reloaded})`)
      console.log('PASS a preview frame request that fails during the take stops it')
    }
    recorder.dispose()
    // A host's onError that throws must not keep a take recording or the camera on: the take
    // ends as it would have, and the exception still reaches the page, once.
    // WebKit reports an exception thrown from an event handler or timer only after running the
    // promise reactions it queued, so each count is read a task later.
    const hostFailure = 'Injected onError failure'
    let rethrown = 0
    const countRethrown = event => { if (event.error && event.error.message === hostFailure) { rethrown++; event.preventDefault() } }
    window.addEventListener('error', countRethrown)
    // A camera or microphone that stops during a take (a dropped Bluetooth microphone, say)
    // keeps the clip so far for review and says so plainly. With nothing recorded there is
    // nothing to review, so the student prepares again. A hidden page keeps its own message.
    const stopped = 'Your camera or microphone stopped. Review what was recorded, or record again.'
    const disconnected = 'Camera or microphone disconnected. Please prepare a new recording.'
    const backgrounded = 'Recording stopped because the app went into the background. Review your clip before submitting.'
    const loseMicrophone = take => { const track = take.stream.getAudioTracks()[0]; track.stop(); track.dispatchEvent(new Event('ended')) }
    const hidePage = () => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
      delete document.hidden
    }
    for (const [name, interrupt, expected, throws] of [['track end with data', loseMicrophone, stopped], ['track end with data, with an onError that throws', loseMicrophone, stopped, true], ['track end with no data', loseMicrophone, disconnected], ['visibility interruption', hidePage, backgrounded], ['visibility interruption, with an onError that throws', hidePage, backgrounded, true]]) {
      const seen = []
      const explained = []
      recorder = new Recorder(canvas, state => seen.push(state), error => { explained.push(error.message); if (throws) throw Error(hostFailure) }, { assetBase })
      await recorder.prepare({ background: 'none' })
      const tracks = recorder.stream.getTracks()
      const take = recorder.start()
      // A take with nothing recorded ends at once, with its chunks dropped. In WebKit, a take
      // stopped this soon sometimes never finishes, so this also covers a lost device given up
      // by the finish timeout. The other takes record for a moment first.
      if (name === 'track end with no data') recorder.recorder.ondataavailable = () => {}
      else await new Promise(resolve => setTimeout(resolve, 1200))
      const before = rethrown
      const interrupted = performance.now()
      interrupt(recorder)
      let clip = null
      let rejected = null
      try { clip = await Promise.race([take, new Promise((resolve, reject) => setTimeout(() => reject(Error('no outcome after 6 s')), 6000))]) } catch (error) { rejected = error.message }
      const settled = Math.round(performance.now() - interrupted)
      if (JSON.stringify(explained) !== JSON.stringify([expected])) throw Error(`${name}: onError must explain once (${explained})`)
      if (expected === disconnected) {
        if (rejected !== disconnected || recorder.state !== 'idle' || seen.includes('review')) throw Error(`${name}: must reject without review (${rejected}; ${seen})`)
      } else if (!clip || !clip.blob.size || recorder.state !== 'review') throw Error(`${name}: must keep the clip for review (${rejected}; ${seen})`)
      if (recorder.stream || recorder.output || tracks.some(track => track.readyState !== 'ended')) throw Error(`${name}: must release the camera and microphone`)
      await new Promise(resolve => setTimeout(resolve))
      if (rethrown - before !== (throws ? 1 : 0)) throw Error(`${name}: the exception thrown by onError must reach the page ${throws ? 'once' : 'never'}, not ${rethrown - before} times`)
      recorder.dispose()
      console.log(`PASS ${name}, settled after ${settled} ms`)
    }
    // Outside a take, a track that ends returns to idle with the camera off, even when onError throws.
    const previewSeen = []
    recorder = new Recorder(canvas, state => previewSeen.push(state), () => { throw Error(hostFailure) }, { assetBase })
    await recorder.prepare({ background: 'none' })
    const previewTracks = recorder.stream.getTracks()
    const beforePreview = rethrown
    loseMicrophone(recorder)
    if (recorder.state !== 'idle' || recorder.stream || previewTracks.some(track => track.readyState !== 'ended')) throw Error(`A track that ends during the preview, with an onError that throws: must release the camera and return to idle (${previewSeen})`)
    await new Promise(resolve => setTimeout(resolve))
    if (rethrown - beforePreview !== 1) throw Error(`A track that ends during the preview: the exception thrown by onError must reach the page once, not ${rethrown - beforePreview} times`)
    recorder.dispose()
    console.log('PASS a track that ends during the preview, with an onError that throws, releases the camera')
    // A background-processing failure during a take, with an onError that throws, still stops
    // the take for review. The failure is injected into the processor's mask, so it runs with
    // or without a worker. It surfaces in the frame timer's promise chain, so the exception
    // reaches the page once as an unhandled rejection, not an error event.
    let unhandled = 0
    const countUnhandled = event => { if (event.reason && event.reason.message === hostFailure) { unhandled++; event.preventDefault() } }
    window.addEventListener('unhandledrejection', countUnhandled)
    try {
      const processingSeen = []
      const processingExplained = []
      recorder = new Recorder(canvas, state => processingSeen.push(state), error => { processingExplained.push(error.message); throw Error(hostFailure) }, { assetBase })
      await recorder.prepare({ background: 'blur' })
      const processingTracks = recorder.stream.getTracks()
      const take = recorder.start()
      await new Promise(resolve => setTimeout(resolve, 1200))
      const before = rethrown
      recorder.processor.mask = () => Promise.reject(new Error('Injected processing failure'))
      const outcome = await Promise.race([take.then(clip => clip, error => error.message), new Promise(resolve => setTimeout(() => resolve('no outcome after 6 s'), 6000))])
      if (!outcome.blob || !outcome.blob.size || recorder.state !== 'review') throw Error(`A processing failure during a take, with an onError that throws: must keep the clip for review, but got ${outcome.blob ? 'an empty clip' : outcome} in state ${recorder.state} (${processingSeen})`)
      if (JSON.stringify(processingExplained) !== JSON.stringify(['Injected processing failure'])) throw Error(`A processing failure during a take, with an onError that throws: onError must explain once, not ${JSON.stringify(processingExplained)}`)
      if (recorder.stream || recorder.output || processingTracks.some(track => track.readyState !== 'ended')) throw Error('A processing failure during a take, with an onError that throws: must release the camera and microphone')
      await new Promise(resolve => setTimeout(resolve))
      if (unhandled !== 1 || rethrown !== before) throw Error(`A processing failure during a take: the exception thrown by onError must reach the page once, as an unhandled rejection (unhandled rejections: ${unhandled}, error events: ${rethrown - before})`)
      recorder.dispose()
      console.log('PASS a processing failure during a take, with an onError that throws, keeps the clip for review')
    } finally { window.removeEventListener('unhandledrejection', countUnhandled) }
    // MediaRecorder can report an error during a take, such as an encoder failure. What it
    // recorded may be cut short or unplayable, so nothing is kept for review: the take is
    // rejected, the failure is explained once, every track is released and the student
    // prepares again, as after a take that never finishes. An error while the take is
    // finishing ends it the same way; one after disposal only cancels it. An onError that
    // throws still gets the take ended, and its exception still reaches the page.
    const failed = 'Recording failed. Please retake the clip.'
    const breakRecorder = take => take.recorder.dispatchEvent(new Event('error'))
    for (const [name, end, expected, explanations, throws] of [['during a take', breakRecorder, failed, ['Recording failed.']], ['during a take, with an onError that throws', breakRecorder, failed, ['Recording failed.'], true], ['while the take is finishing', take => { take.stop(); breakRecorder(take) }, failed, ['Recording failed.']], ['after disposal', take => { take.dispose(); breakRecorder(take) }, 'AbortError', []]]) {
      const seen = []
      const explained = []
      recorder = new Recorder(canvas, state => seen.push(state), error => { explained.push(error.message); if (throws) throw Error(hostFailure) }, { assetBase })
      await recorder.prepare({ background: 'none' })
      const tracks = recorder.stream.getTracks()
      const take = recorder.start()
      // Long enough for a chunk of data to arrive, so there is something that could be kept.
      await new Promise(resolve => setTimeout(resolve, 1200))
      const before = rethrown
      end(recorder)
      const outcome = await Promise.race([take.then(() => 'a clip', error => error.name === 'AbortError' ? error.name : error.message), new Promise(resolve => setTimeout(() => resolve('no outcome after 6 s'), 6000))])
      if (outcome !== expected) throw Error(`A MediaRecorder error ${name}: expected ${expected}, got ${outcome} (${seen})`)
      if (JSON.stringify(explained) !== JSON.stringify(explanations)) throw Error(`A MediaRecorder error ${name}: onError must explain ${JSON.stringify(explanations)}, not ${JSON.stringify(explained)}`)
      if (recorder.state !== (expected === 'AbortError' ? 'disposed' : 'idle') || seen.includes('review')) throw Error(`A MediaRecorder error ${name}: must end the take with nothing for review, but the state is ${recorder.state} (${seen})`)
      if (recorder.stream || recorder.output || tracks.some(track => track.readyState !== 'ended')) throw Error(`A MediaRecorder error ${name}: must release the camera and microphone`)
      await new Promise(resolve => setTimeout(resolve))
      if (rethrown - before !== (throws ? 1 : 0)) throw Error(`A MediaRecorder error ${name}: the exception thrown by onError must reach the page ${throws ? 'once' : 'never'}, not ${rethrown - before} times`)
      if (expected !== 'AbortError') {
        await recorder.prepare({ background: 'none' })
        // The failed take's MediaRecorder may still report data or a stop; none of it may revive the take.
        await new Promise(resolve => setTimeout(resolve, 300))
        if (recorder.state !== 'preview' || seen.includes('review')) throw Error(`A MediaRecorder error ${name}: the student must be able to prepare again (${seen})`)
      }
      recorder.dispose()
      console.log(`PASS a MediaRecorder error ${name} keeps nothing for review`)
    }
    // In WebKit, a take stopped moments after it starts can leave MediaRecorder silent: it goes
    // inactive, but neither stop nor error ever fires. Here every recorder that is told to stop
    // does that. The take must still end within a few seconds with no clip, every track released
    // and the reason given once. A take stopped by an error was already explained with a promise
    // of review, so the reason replaces that explanation. A take disposed of meanwhile is
    // rejected as cancelled and explains nothing. An onError that throws still gets the take
    // given up and its tracks released, and its exception still reaches the page.
    const unfinished = 'Recording could not be finished. Please record again.'
    const silenced = new WeakSet()
    const recorderApi = Object.fromEntries(['stop', 'ondataavailable', 'onstop', 'onerror'].map(name => [name, Object.getOwnPropertyDescriptor(MediaRecorder.prototype, name)]))
    MediaRecorder.prototype.stop = function () { silenced.add(this); return recorderApi.stop.value.call(this) }
    for (const name of ['ondataavailable', 'onstop', 'onerror']) {
      const { get, set } = recorderApi[name]
      Object.defineProperty(MediaRecorder.prototype, name, { configurable: true, get, set (listener) { set.call(this, listener && (event => { if (!silenced.has(this)) listener(event) })) } })
    }
    try {
      for (const [name, end, expected, explanations, throws] of [['Stop', take => take.stop(), unfinished, [unfinished]], ['Stop, with an onError that throws', take => take.stop(), unfinished, [unfinished], true], ['track end', loseMicrophone, disconnected, [disconnected]], ['a hidden page', hidePage, unfinished, [backgrounded, unfinished]], ['disposal', take => take.dispose(), 'AbortError', []]]) {
        const seen = []
        const explained = []
        recorder = new Recorder(canvas, state => seen.push(state), error => { explained.push(error.message); if (throws) throw Error(hostFailure) }, { assetBase })
        await recorder.prepare({ background: 'none' })
        const tracks = recorder.stream.getTracks()
        const take = recorder.start()
        await new Promise(resolve => setTimeout(resolve, 600))
        const before = rethrown
        const ended = performance.now()
        end(recorder)
        const outcome = await Promise.race([take.then(() => 'a clip', error => error.name === 'AbortError' ? error.name : error.message), new Promise(resolve => setTimeout(() => resolve('still finishing after 6 s'), 6000))])
        const waited = performance.now() - ended
        if (outcome !== expected) throw Error(`A take that never finishes, ended by ${name}: expected ${expected}, got ${outcome} (${seen})`)
        if (waited < 2900) throw Error(`A take that never finishes, ended by ${name}: gave up after ${Math.round(waited)} ms, before MediaRecorder had 3 s to finish`)
        if (JSON.stringify(explained) !== JSON.stringify(explanations)) throw Error(`A take that never finishes, ended by ${name}: onError must explain ${JSON.stringify(explanations)}, not ${JSON.stringify(explained)}`)
        if (recorder.state !== (expected === 'AbortError' ? 'disposed' : 'idle') || seen.includes('review')) throw Error(`A take that never finishes, ended by ${name}: wrong state (${seen})`)
        if (recorder.stream || recorder.output || tracks.some(track => track.readyState !== 'ended')) throw Error(`A take that never finishes, ended by ${name}: must release the camera and microphone`)
        await new Promise(resolve => setTimeout(resolve))
        if (rethrown - before !== (throws ? 1 : 0)) throw Error(`A take that never finishes, ended by ${name}: the exception thrown by onError must reach the page ${throws ? 'once' : 'never'}, not ${rethrown - before} times`)
        recorder.dispose()
        console.log(`PASS a take that never finishes, ended by ${name}, is given up after ${Math.round(waited)} ms`)
      }
    } finally {
      for (const [name, descriptor] of Object.entries(recorderApi)) Object.defineProperty(MediaRecorder.prototype, name, descriptor)
      window.removeEventListener('error', countRethrown)
    }
    // An audio-only take records only the microphone, in WebKit too.
    recorder = new Recorder(canvas, state => states.push(state), error => errors.push(error.message), { assetBase })
    await recorder.prepare({ audioOnly: true })
    const audioDone = recorder.start(); await new Promise(resolve => setTimeout(resolve, 1100)); recorder.stop()
    const audio = await audioDone
    if (!audio.mimeType.startsWith('audio/')) throw Error('Audio mislabeled')
    const listener = document.createElement('audio')
    listener.src = URL.createObjectURL(audio.blob)
    await new Promise((resolve, reject) => { listener.onloadedmetadata = resolve; listener.onerror = () => reject(Error('Recorded audio cannot play')); setTimeout(() => reject(Error('Recorded audio timed out loading')), 10000) })
    URL.revokeObjectURL(listener.src)
    const audioBytes = audio.blob.size
    console.log('PASS audio-only take')
    // MediaRecorder stops by itself when the microphone ends, which may come before the
    // track's ended event. The clip is still kept.
    recorder.dispose()
    const explained = []
    recorder = new Recorder(canvas, state => states.push(state), error => explained.push(error.message), { assetBase })
    await recorder.prepare({ audioOnly: true })
    const cut = recorder.start(); await new Promise(resolve => setTimeout(resolve, 1200))
    recorder.stream.getAudioTracks()[0].stop()
    const partial = await cut
    if (!partial.blob.size || recorder.state !== 'review' || JSON.stringify(explained) !== JSON.stringify([stopped])) throw Error(`A microphone that ends an audio-only take must keep it for review (${explained})`)
    console.log('PASS microphone end stops an audio-only take for review')
    recorder.dispose(); recorder.dispose()
    if (recorder.state !== 'disposed' || recorder.stream) throw Error('Resource leak')
    return { states, errors, tests, format: recordingFormat(), audioFormat: audio.mimeType, audioBytes }
  }, { backgrounds, assetBase, synthetic: process.env.BROWSER === 'webkit', expectWorker })
  assert.deepEqual(errors, [])
  if (noCorsBase) {
    // An asset origin that sends no CORS headers cannot serve the WASM, model or module to
    // the page. The preview fails with the usual explanation and keeps the camera, and the
    // student can still choose None with it. WebKit reports the script load this blocks as a
    // page error although the page catches it, so this case runs on its own and allows that.
    await page.evaluate(async noCorsBase => {
      const { default: Recorder } = await import('/Recorder.js')
      const seen = []
      const explained = []
      const recorder = new Recorder(document.querySelector('canvas'), state => seen.push(state), error => explained.push(error.message), { assetBase: noCorsBase })
      let refused = ''
      try { await recorder.prepare({ background: 'blur' }) } catch (error) { refused = error.message }
      const camera = recorder.stream
      if (!refused.startsWith('Background effects could not start.')) throw Error(`An asset origin without CORS must fail with the usual explanation, not ${JSON.stringify(refused)}`)
      if (recorder.state !== 'setup-error' || !camera || !camera.getTracks().every(track => track.readyState === 'live')) throw Error(`An asset origin without CORS must keep the camera (${seen})`)
      await recorder.prepare({ background: 'none' })
      if (recorder.state !== 'preview' || recorder.stream !== camera) throw Error(`After an asset origin without CORS, None must preview with the same camera (${seen})`)
      if (explained.length) throw Error(`A preview that fails reports through prepare(), not onError (${explained})`)
      recorder.dispose()
      console.log('PASS an asset origin without CORS fails with the usual explanation and keeps the camera')
    }, noCorsBase)
    assert.deepEqual(errors.filter(message => !/Cross-Origin Resource Sharing/.test(message)), [])
  }
  assert.deepEqual(offsite, [], 'The recorder requested something from an origin other than the page\'s and its assets\'')
  assert.deepEqual(uploads, [], 'The recorder sent something to the page\'s or the assets\' origin')
  assert.deepEqual(result.errors, [])
  assert.equal(result.tests.length, backgrounds.length)
  console.log(JSON.stringify(result, null, 2))
} finally { clearTimeout(watchdog); await browser.close(); server.close(); if (assetServer) assetServer.close() }
