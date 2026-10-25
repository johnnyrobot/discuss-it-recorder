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
const assetBase = '/static/recorder/'
// iPhone mode uses the main thread by design, and FAIL_WORKER removes the worker.
const expectWorker = process.env.IPHONE !== '1' && process.env.FAIL_WORKER !== '1'
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width"><canvas id="preview"></canvas>'); return }
  const url = req.url.split('?')[0]
  const source = ['/Recorder.js', '/BackgroundProcessor.js', '/BackgroundImage.js'].includes(url) ? path.join(root, 'resources/js/media/recording', url.slice(1))
    : url === `${assetBase}segmenter-worker.js` ? path.join(root, 'resources/js/media/recording/segmenter-worker.js')
      : url.startsWith(assetBase) ? path.join(root, 'public/assets/discuss-it', url.slice(assetBase.length)) : ''
  if (!source.startsWith(root) || !fs.existsSync(source) || !fs.statSync(source).isFile()) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', /\.m?js$/.test(source) ? 'application/javascript' : source.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
  fs.createReadStream(source).pipe(res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = process.env.BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${cameraFile}`] })
const watchdog = setTimeout(async () => { console.error('Browser test timed out'); await browser.close() }, 90000)
const backgrounds = process.env.BACKGROUND ? [process.env.BACKGROUND] : ['none', 'color', 'blur', 'image']
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    ...(process.env.IPHONE === '1' ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1' } : {}) })
  const errors = []
  page.on('console', message => console.log('browser:', message.text()))
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
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
  const result = await page.evaluate(async ({ backgrounds, skipAudioOnly, assetBase, synthetic, expectWorker }) => {
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
        const pixels = document.createElement('canvas'); pixels.width = 640; pixels.height = 480
        const context = pixels.getContext('2d', { willReadFrequently: true }); context.drawImage(player, 0, 0, 640, 480)
        const left = context.getImageData(100, 240, 1, 1).data
        const right = context.getImageData(540, 240, 1, 1).data
        if (!(left[2] > left[0] + 100 && right[0] > right[2] + 100)) throw Error('Saved video is not mirrored')
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
    for (const [name, interrupt, expected] of [['track end with data', loseMicrophone, stopped], ['track end with no data', loseMicrophone, disconnected], ['visibility interruption', hidePage, backgrounded]]) {
      const seen = []
      const explained = []
      recorder = new Recorder(canvas, state => seen.push(state), error => explained.push(error.message), { assetBase })
      await recorder.prepare({ background: 'none' })
      const take = recorder.start()
      // Drop the recorded chunks for a take with nothing recorded. Still wait before ending
      // it: in Playwright's WebKit, a take stopped within moments of starting sometimes never finishes.
      if (name === 'track end with no data') recorder.recorder.ondataavailable = () => {}
      await new Promise(resolve => setTimeout(resolve, 1200))
      interrupt(recorder)
      let clip = null
      let rejected = null
      try { clip = await take } catch (error) { rejected = error.message }
      if (JSON.stringify(explained) !== JSON.stringify([expected])) throw Error(`${name}: onError must explain once (${explained})`)
      if (expected === disconnected) {
        if (rejected !== disconnected || recorder.state !== 'idle' || seen.includes('review')) throw Error(`${name}: must reject without review (${rejected}; ${seen})`)
      } else if (!clip || !clip.blob.size || recorder.state !== 'review') throw Error(`${name}: must keep the clip for review (${rejected}; ${seen})`)
      if (recorder.stream) throw Error(`${name}: must release the camera and microphone`)
      recorder.dispose()
      console.log(`PASS ${name}`)
    }
    let audioBytes = null
    if (!skipAudioOnly) {
      recorder = new Recorder(canvas, state => states.push(state), error => errors.push(error.message), { assetBase })
      await recorder.prepare({ audioOnly: true })
      const audioDone = recorder.start(); await new Promise(resolve => setTimeout(resolve, 1100)); recorder.stop()
      const audio = await audioDone
      if (!audio.mimeType.startsWith('audio/')) throw Error('Audio mislabeled')
      audioBytes = audio.blob.size
      // An audio-only take records only the microphone, so MediaRecorder stops by itself
      // when it ends, which may come before the track's ended event. The clip is still kept.
      recorder.dispose()
      const explained = []
      recorder = new Recorder(canvas, state => states.push(state), error => explained.push(error.message), { assetBase })
      await recorder.prepare({ audioOnly: true })
      const cut = recorder.start(); await new Promise(resolve => setTimeout(resolve, 1200))
      recorder.stream.getAudioTracks()[0].stop()
      const partial = await cut
      if (!partial.blob.size || recorder.state !== 'review' || JSON.stringify(explained) !== JSON.stringify([stopped])) throw Error(`A microphone that ends an audio-only take must keep it for review (${explained})`)
      console.log('PASS microphone end stops an audio-only take for review')
    }
    recorder.dispose(); recorder.dispose()
    if (recorder.state !== 'disposed' || recorder.stream) throw Error('Resource leak')
    return { states, errors, tests, format: recordingFormat(), audioBytes, skipAudioOnly }
  }, { backgrounds, skipAudioOnly: process.env.BROWSER === 'webkit', assetBase, synthetic: process.env.BROWSER === 'webkit', expectWorker })
  assert.deepEqual(errors, [])
  assert.deepEqual(result.errors, [])
  assert.equal(result.tests.length, backgrounds.length)
  console.log(JSON.stringify(result, null, 2))
} finally { clearTimeout(watchdog); await browser.close(); server.close() }
