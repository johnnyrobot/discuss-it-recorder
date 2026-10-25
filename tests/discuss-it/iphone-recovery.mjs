// Real Vue recorder + synthetic capture: deterministic post-permission failures.
// No real camera, uploads, accounts, or server writes are used.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const { webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const root = process.cwd()
const component = fs.readFileSync(path.join(root, 'resources/js/components/recording/VideoRecorder.vue'), 'utf8')
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/javascript')
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<meta name="viewport" content="width=device-width"><div id="app"></div><script type="module">import Vue from "/vue.js"; import Component from "/Component.js"; window.recordedEvents = []; window.recordingEvents = []; new Vue({render:h=>h(Component, { on: { recorded: result => window.recordedEvents.push(result ? "take" : null), recording: value => window.recordingEvents.push(value) } })}).$mount("#app")</script>'); return }
  if (req.url === '/Component.js') {
    const script = component.match(/<script>([\s\S]*?)<\/script>/)[1].replace("'../../media/recording/Recorder'", "'/Recorder.js'").replace("'../../media/recording/BackgroundImage.js'", "'/BackgroundImage.js'").replace('export default', 'const component =')
    res.end(`${script}\ncomponent.template = ${JSON.stringify(component.match(/<template>([\s\S]*?)<\/template>/)[1])}; export default component`); return
  }
  const files = { '/vue.js': 'node_modules/vue/dist/vue.esm.browser.js', '/Recorder.js': 'resources/js/media/recording/Recorder.js', '/BackgroundProcessor.js': 'resources/js/media/recording/BackgroundProcessor.js', '/BackgroundImage.js': 'resources/js/media/recording/BackgroundImage.js' }
  const source = files[req.url] || `public${req.url.split('?')[0]}`
  if (!fs.existsSync(path.join(root, source))) { res.writeHead(404); res.end(); return }
  if (source.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
  if (source.endsWith('.tflite')) res.setHeader('Content-Type', 'application/octet-stream')
  fs.createReadStream(path.join(root, source)).pipe(res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await webkit.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1' })
  page.on('pageerror', error => console.log('Test page error:', error.message))
  const installCapture = () => {
    window.captureRequests = 0
    window.rejectPlayback = true
    const originalPlay = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      if (this.srcObject && window.rejectPlayback) { window.rejectPlayback = false; return Promise.reject(new DOMException('Playback requires a user gesture', 'NotAllowedError')) }
      return originalPlay.call(this)
    }
    // Replace capture on the prototype: WebKit can discard the navigator.mediaDevices
    // wrapper with any instance overrides, and a later tap would open the real camera.
    MediaDevices.prototype.getUserMedia = async function syntheticCapture () {
      window.captureRequests++
      const source = document.createElement('canvas'); source.width = 320; source.height = 240
      const paint = () => { const ctx = source.getContext('2d'); ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, 160, 240); ctx.fillStyle = '#00f'; ctx.fillRect(160, 0, 160, 240) }
      paint(); setInterval(paint, 50)
      const audio = new AudioContext(); const oscillator = audio.createOscillator(); const output = audio.createMediaStreamDestination(); oscillator.connect(output); oscillator.start(); audio.resume()
      window.cameraStream = new MediaStream([...source.captureStream(15).getVideoTracks(), ...output.stream.getAudioTracks()])
      return window.cameraStream
    }
    MediaDevices.prototype.enumerateDevices = async () => []
  }
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.evaluate(installCapture)
  assert.ok(await page.evaluate(() => navigator.mediaDevices.getUserMedia.toString().includes('captureRequests')), 'Capture fault-injection fixture installed')
  await page.getByRole('button', { name: 'Enable camera & microphone', exact: true }).click()
  try { await page.getByRole('alert').waitFor({ timeout: 15000 }) } catch (error) {
    console.log('Recovery controls:', await page.locator('.discuss-recorder').innerText())
    console.log('Capture calls:', await page.evaluate(() => window.captureRequests))
    throw error
  }
  const tracksRetained = await page.evaluate(() => window.cameraStream.getTracks().every(track => track.readyState === 'live'))
  assert.ok(tracksRetained, 'A blocked preview must retain the already-authorized camera instead of forcing another permission request')
  assert.ok(!(await page.getByRole('alert').innerText()).includes('permission was denied'), 'Playback restriction is not camera permission denial')
  await page.getByRole('button', { name: 'Retry preview', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.captureRequests), 1)
  console.log('PASS playback recovery without another camera permission request')
  await page.route('**/selfie_segmenter.tflite', route => route.abort(), { times: 1 })
  await page.getByRole('combobox', { name: /^Background/ }).selectOption('blur')
  await page.getByRole('button', { name: 'Retry preview', exact: true }).waitFor({ timeout: 60000 })
  assert.equal(await page.getByRole('button', { name: 'Start recording', exact: true }).count(), 0, 'Do not record raw video when the selected background fails')
  assert.ok(await page.evaluate(() => window.cameraStream.getTracks().every(track => track.readyState === 'live')))
  assert.equal(await page.evaluate(() => window.captureRequests), 1)
  await page.getByRole('button', { name: 'Retry preview', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor({ timeout: 60000 })
  assert.equal(await page.evaluate(() => window.captureRequests), 1, 'Changing background must reuse the camera')
  await page.getByLabel('Mirror video (also mirrors saved text)', { exact: true }).check()
  await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.captureRequests), 1, 'Changing mirror must reuse the camera')
  console.log('PASS failed background recovery and mirror changes preserve camera permission')
  if (process.env.IMAGE) {
    const largePhoto = process.env.IMAGE === '1'
    const photo = await page.evaluate(async largePhoto => {
      const canvas = document.createElement('canvas')
      canvas.width = largePhoto ? 3072 : 640; canvas.height = largePhoto ? 2048 : 480
      const ctx = canvas.getContext('2d')
      const pixels = ctx.createImageData(canvas.width, canvas.height)
      let seed = 1
      for (let i = 0; i < pixels.data.length; i += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        pixels.data[i] = seed & 255; pixels.data[i + 1] = (seed >>> 8) & 255
        pixels.data[i + 2] = (seed >>> 16) & 255; pixels.data[i + 3] = 255
      }
      ctx.putImageData(pixels, 0, 0)
      return canvas.toDataURL('image/jpeg', 0.95).split(',')[1]
    }, largePhoto)
    const buffer = Buffer.from(photo, 'base64')
    if (largePhoto) assert.ok(buffer.length > 5000000 && buffer.length < 20000000, `Exercise a high-resolution photo larger than the old 5 MB limit (fixture: ${buffer.length} bytes)`)
    // IMAGE=decoder: photo loading must not depend on createImageBitmap(Blob), whose
    // failures on iPhone previously left the preview unavailable.
    if (process.env.IMAGE === 'decoder') await page.evaluate(() => {
      const original = window.createImageBitmap
      window.createImageBitmap = (source, ...args) => source instanceof Blob ? Promise.reject(new DOMException('The image could not be decoded', 'InvalidStateError')) : original(source, ...args)
    })
    await page.getByRole('combobox', { name: /^Background/ }).selectOption('image')
    await page.locator('.discuss-recorder input[type=file]').setInputFiles({ name: 'background-photo.jpg', mimeType: 'image/jpeg', buffer })
    await page.waitForFunction(() => document.querySelector('.discuss-recorder').textContent.includes('Start recording'), null, { timeout: 20000 }).catch(async () => {
      throw Error(`Image background did not reach preview: ${await page.locator('.discuss-recorder [role=alert]').innerText()}`)
    })
    assert.equal(await page.evaluate(() => window.captureRequests), 1, 'Selecting a photo must retain the front camera')
    assert.ok(await page.locator('.discuss-recorder canvas').evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      let green = 0
      for (let i = 1; i < pixels.length; i += 4) green += pixels[i]
      return green / (pixels.length / 4) > 20
    }), 'Photo pixels must replace the synthetic red/blue camera background, not silently show raw capture')
    console.log('PASS Photos-sized custom background reaches preview with the same front camera')
  }
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await page.waitForTimeout(1600)
  await page.getByRole('button', { name: 'Stop & review', exact: true }).click()
  await page.getByRole('link', { name: 'Download a copy', exact: true }).waitFor()
  if (process.env.IMAGE) assert.ok(await page.getByLabel('Review recording', { exact: true }).evaluate(async video => {
    video.muted = true; await video.play()
    await new Promise(resolve => setTimeout(resolve, 500))
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let green = 0
    for (let i = 1; i < pixels.length; i += 4) green += pixels[i]
    video.pause()
    return green / (pixels.length / 4) > 20
  }), 'Custom photo must be encoded in the saved recording')
  assert.ok(await page.evaluate(() => window.cameraStream.getTracks().every(track => track.readyState === 'ended')))
  assert.deepEqual(await page.evaluate(() => window.recordingEvents), [true, false], '`recording` marks when the take starts and stops')
  console.log('PASS recovered iPhone-mode preview records and releases camera on review')
  // Cancel during a take discards it, and Cancel without a take leaves the host's attachment alone.
  assert.deepEqual(await page.evaluate(() => window.recordedEvents), ['take'])
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Retake', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor({ timeout: 60000 })
  assert.deepEqual(await page.evaluate(() => window.recordedEvents), ['take', null], 'Retake clears the previous take')
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.waitForTimeout(1500)
  assert.equal(await page.getByRole('link', { name: 'Download a copy', exact: true }).count(), 0, 'A cancelled take is not offered for download')
  assert.equal(await page.getByLabel('Review recording', { exact: true }).count(), 0, 'A cancelled take is not shown for review')
  assert.equal(await page.getByRole('alert').count(), 0, 'Cancelling is not an error')
  assert.deepEqual(await page.evaluate(() => window.recordedEvents), ['take', null], 'A cancelled take is never emitted')
  assert.deepEqual(await page.evaluate(() => window.recordingEvents), [true, false, true, false], 'Cancelling a take also ends `recording`')
  await page.getByRole('button', { name: 'Enable camera & microphone', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor({ timeout: 60000 })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.recordedEvents), ['take', null], 'Cancel without a take does not clear the host attachment')
  console.log('PASS cancelled takes are discarded and Cancel without a take keeps the host attachment')
  // A missing microphone fails while a camera is selected, but the camera is still there,
  // so it stays selected. Chromium reports it as NotFoundError; Safari may report
  // OverconstrainedError, as Chromium does for an exact camera that is unplugged.
  const camera = page.getByRole('combobox', { name: /^Camera/ })
  await page.evaluate(() => {
    window.usbCamera = 'no-microphone'
    MediaDevices.prototype.enumerateDevices = async () => window.usbCamera === 'unplugged' ? [] : [{ deviceId: 'usb-camera', groupId: '', kind: 'videoinput', label: 'USB camera' }]
    const getUserMedia = MediaDevices.prototype.getUserMedia
    MediaDevices.prototype.getUserMedia = async function syntheticCapture (constraints) {
      if (constraints.video && constraints.video.deviceId && window.usbCamera !== 'connected') throw new DOMException('', window.usbCamera === 'unplugged' ? 'OverconstrainedError' : 'NotFoundError')
      return getUserMedia.call(this, constraints)
    }
  })
  await page.getByRole('button', { name: 'Enable camera & microphone', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor({ timeout: 60000 })
  await camera.selectOption('usb-camera')
  await page.getByRole('alert').filter({ hasText: 'microphone was found' }).waitFor()
  await page.waitForTimeout(500)
  assert.equal(await camera.inputValue(), 'usb-camera', 'A missing microphone keeps the selected camera')
  await page.evaluate(() => { window.usbCamera = 'connected' })
  await page.getByRole('button', { name: 'Enable camera & microphone', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor({ timeout: 60000 })
  console.log('PASS a missing microphone keeps the selected camera for the retry')
  // Errors without a message are still explained, and a camera that disappeared is
  // deselected so a retry can use the default camera.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.evaluate(() => { window.usbCamera = 'unplugged' })
  await page.getByRole('button', { name: 'Enable camera & microphone', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'not available' }).waitFor()
  await page.waitForFunction(() => document.querySelector('.discuss-recorder select').value === '', null, { timeout: 5000 }).catch(() => { throw Error('The unplugged camera is no longer selected') })
  await page.getByRole('button', { name: 'Enable camera & microphone', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor({ timeout: 60000 })
  console.log('PASS an error without a message is explained and the default camera works on retry')
  // A microphone that stops during a take keeps the clip for review and says so. With
  // nothing recorded there is nothing to review: the student prepares again.
  const loseMicrophone = () => page.evaluate(() => { const track = window.cameraStream.getAudioTracks()[0]; track.stop(); track.dispatchEvent(new Event('ended')) })
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await page.waitForTimeout(1200)
  await loseMicrophone()
  await page.getByRole('link', { name: 'Download a copy', exact: true }).waitFor()
  assert.equal(await page.getByRole('alert').innerText(), 'Your camera or microphone stopped. Review what was recorded, or record again.')
  assert.equal(await page.getByRole('button', { name: 'Retake', exact: true }).count(), 1, 'The partial take can be recorded again')
  const recorded = await page.evaluate(() => window.recordedEvents.slice())
  assert.equal(recorded.at(-1), 'take', 'The partial take is offered to the host')
  console.log('PASS a microphone that stops during a take keeps the clip for review')
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Retake', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor({ timeout: 60000 })
  // Drop every recorded chunk, as if the microphone stopped before the first one arrived.
  // Still wait before ending it: in Playwright's WebKit, a take stopped within moments of
  // starting sometimes never finishes.
  await page.evaluate(() => {
    const handler = Object.getOwnPropertyDescriptor(MediaRecorder.prototype, 'ondataavailable')
    Object.defineProperty(MediaRecorder.prototype, 'ondataavailable', { configurable: true, get: handler.get, set (listener) { handler.set.call(this, listener && (() => {})) } })
  })
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await page.waitForTimeout(1200)
  await loseMicrophone()
  await page.getByRole('button', { name: 'Enable camera & microphone', exact: true }).waitFor()
  assert.equal(await page.getByRole('alert').innerText(), 'Camera or microphone disconnected. Please prepare a new recording.')
  assert.equal(await page.getByLabel('Review recording', { exact: true }).count(), 0, 'An empty take is not shown for review')
  assert.deepEqual(await page.evaluate(() => window.recordedEvents), [...recorded, null], 'An empty take is never emitted')
  assert.deepEqual((await page.evaluate(() => window.recordingEvents)).slice(-2), [true, false], 'An empty take still ends `recording`')
  console.log('PASS a microphone that stops before anything is recorded asks to prepare again')
} finally { await browser.close(); server.close() }
