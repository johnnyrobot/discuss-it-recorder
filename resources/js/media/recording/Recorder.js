// One owner for media resources. No network uploads or assignment state here.
import BackgroundProcessor from './BackgroundProcessor.js'
import loadBackgroundImage from './BackgroundImage.js'
export function recordingFormat (Recorder = MediaRecorder, audioOnly = false) {
  const candidates = audioOnly
    ? ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    : ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']
  return candidates.find(type => Recorder.isTypeSupported(type)) || ''
}

export function extensionFor (mimeType) {
  if (mimeType.includes('mp4')) return mimeType.startsWith('audio/') ? 'm4a' : 'mp4'
  if (mimeType.includes('webm')) return 'webm'
  throw new Error('The browser returned an unsupported recording format.')
}

const disconnected = 'Camera or microphone disconnected. Please prepare a new recording.'
const unfinished = 'Recording could not be finished. Please record again.'
// How long a take may stay finishing after stop() before it is given up. Takes in WebKit
// and Chromium finish within a fraction of a second, so this only ends one that never will.
const FINISH_TIMEOUT_MS = 3000

export default class Recorder {
  constructor (canvas, onState = () => {}, onError = () => {}, { assetBase } = {}) {
    this.canvas = canvas
    this.onState = onState
    this.onError = onError
    this.assetBase = assetBase
    this.state = 'idle'
    this.generation = 0
    this.video = document.createElement('video')
    this.video.muted = true
    this.video.defaultMuted = true
    this.video.playsInline = true
    this.video.setAttribute('muted', '')
    this.video.autoplay = true
    this.video.setAttribute('playsinline', '')
    this.video.setAttribute('webkit-playsinline', '')
    // Safari needs an attached, playing source. Never display raw camera pixels.
    this.video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px'
    document.body.appendChild(this.video)
    this.visibility = () => {
      if (document.hidden && this.state === 'recording') this.fail(new Error('Recording stopped because the app went into the background. Review your clip before submitting.'))
    }
    document.addEventListener('visibilitychange', this.visibility)
  }

  setState (value) { this.state = value; this.onState(value) }

  async prepare (settings) {
    if (['recording', 'finalizing', 'disposed'].includes(this.state)) throw new Error('Stop the recording before changing settings.')
    if (this.state === 'preparing') return
    // A new session has no take yet; stop() must not return the previous one.
    this.result = null
    const generation = ++this.generation
    const previous = this.settings
    const next = { facingMode: 'user', background: 'none', mirror: false, audioOnly: false, ...settings }
    const reuseCamera = this.stream && this.stream.getTracks().every(track => track.readyState === 'live') && previous &&
      previous.audioOnly === next.audioOnly && previous.facingMode === next.facingMode && previous.deviceId === next.deviceId
    if (reuseCamera) this.releaseEffects()
    else this.release()
    this.setState('preparing')
    this.settings = next
    try {
      if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error('Recording is unavailable here. Open this page in Safari or Chrome, or upload a recording.')
      if (next.background === 'image' && !next.audioOnly && !next.image) throw new Error('Choose a background image first.')
      const stream = reuseCamera ? this.stream : await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: this.settings.audioOnly ? false : {
          ...(this.settings.deviceId ? { deviceId: { exact: this.settings.deviceId } } : { facingMode: { ideal: this.settings.facingMode } }),
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 15, max: 24 }
        }
      })
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return }
      this.stream = stream
      stream.getTracks().forEach(track => { track.onended = () => this.trackEnded() })
      if (!this.settings.audioOnly) {
        // Keep microphone audio in the recording stream, not the hidden preview.
        // On retries call play immediately, directly within the user's tap.
        if (!reuseCamera) this.video.srcObject = new MediaStream(stream.getVideoTracks())
        let playbackTimeout
        try {
          await Promise.race([this.video.play(), new Promise((resolve, reject) => {
            playbackTimeout = setTimeout(() => reject(new Error('Preview timed out.')), 12000)
          })])
        } catch (error) {
          throw new Error('Camera access was granted, but the preview did not start. Tap Retry preview to resume it. Keep this page open and close other apps using the camera.')
        } finally { clearTimeout(playbackTimeout) }
        if (generation !== this.generation) return
        const w = this.video.videoWidth || 640
        const h = this.video.videoHeight || 480
        const scale = Math.min(1, 640 / Math.max(w, h))
        this.canvas.width = Math.floor(w * scale / 2) * 2
        this.canvas.height = Math.floor(h * scale / 2) * 2
        this.stage = document.createElement('canvas')
        this.stage.width = this.canvas.width
        this.stage.height = this.canvas.height
        if (this.settings.background === 'image') {
          this.imageLoad = new AbortController()
          const backgroundImage = await loadBackgroundImage(this.settings.image, this.imageLoad.signal)
          if (generation !== this.generation) { backgroundImage.close(); return }
          this.backgroundImage = backgroundImage
        }
        if (generation !== this.generation) return
        if (this.settings.background !== 'none') await this.prepareWorker()
        if (generation !== this.generation) return
        await this.drawFrame(generation)
        this.timer = setInterval(() => this.drawFrame(generation).catch(error => { if (generation === this.generation) this.fail(error) }), 1000 / 15)
      }
      if (generation === this.generation) this.setState('preview')
      // Device discovery is optional; it must not delay playback or revoke an
      // already granted camera if iOS rejects enumeration.
      let devices = []
      try { devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput') } catch (error) { /* Facing-mode switching remains available. */ }
      return devices
    } catch (error) {
      if (generation !== this.generation) return
      this.releaseEffects()
      if (this.stream && this.stream.getTracks().every(track => track.readyState === 'live')) this.setState('setup-error')
      else { this.release(); this.setState('idle') }
      throw error
    }
  }

  async prepareWorker () {
    this.processor = new BackgroundProcessor(this.assetBase)
    await this.processor.init()
  }

  async drawFrame (generation) {
    if (this.busy || generation !== this.generation || !this.stage) return
    this.busy = true
    try {
      const width = this.canvas.width
      const height = this.canvas.height
      const ctx = this.stage.getContext('2d')
      ctx.globalCompositeOperation = 'source-over'
      ctx.drawImage(this.video, 0, 0, width, height)
      if (this.processor) {
        // Decide when a worker request fails, not when it is sent: a request sent in preview
        // can time out after Start, and a take must not reload the model mid-recording.
        const mask = await this.processor.mask(this.stage, performance.now(), { recover: () => ['preparing', 'preview'].includes(this.state) })
        if (generation !== this.generation) return
        if (!this.maskCanvas) this.maskCanvas = document.createElement('canvas')
        this.maskCanvas.width = mask.width
        this.maskCanvas.height = mask.height
        const maskContext = this.maskCanvas.getContext('2d')
        const pixels = maskContext.createImageData(mask.width, mask.height)
        const values = new Float32Array(mask.values)
        for (let i = 0; i < values.length; i++) {
          pixels.data[i * 4 + 3] = Math.max(0, Math.min(255, (values[i] - 0.2) * 425))
        }
        maskContext.putImageData(pixels, 0, 0)
        ctx.globalCompositeOperation = 'destination-in'
        ctx.drawImage(this.maskCanvas, 0, 0, width, height)
        ctx.globalCompositeOperation = 'destination-over'
        if (this.settings.background === 'image') {
          const image = this.backgroundImage
          const scale = Math.max(width / image.width, height / image.height)
          ctx.drawImage(image.source, (width - image.width * scale) / 2, (height - image.height * scale) / 2, image.width * scale, image.height * scale)
        } else if (this.settings.background === 'blur') {
          // Down/up sampling also works on mobile Safari without Canvas filter support.
          if (!this.blurCanvas) this.blurCanvas = document.createElement('canvas')
          this.blurCanvas.width = 16
          this.blurCanvas.height = Math.max(1, Math.round(height / width * 16))
          this.blurCanvas.getContext('2d').drawImage(this.video, 0, 0, this.blurCanvas.width, this.blurCanvas.height)
          ctx.drawImage(this.blurCanvas, 0, 0, width, height)
        } else { ctx.fillStyle = '#64748b'; ctx.fillRect(0, 0, width, height) }
      }
      if (generation !== this.generation) return
      const output = this.canvas.getContext('2d')
      output.save()
      if (this.settings.mirror) { output.translate(width, 0); output.scale(-1, 1) }
      output.drawImage(this.stage, 0, 0)
      output.restore()
    } finally { if (generation === this.generation) this.busy = false }
  }

  start () {
    if (this.state !== 'preview') throw new Error('Prepare the camera first.')
    if (this.processor && this.processor.recovering) throw new Error('The background effect is restarting. Wait for the preview to move again, then record.')
    this.chunks = []
    this.bytes = 0
    this.deviceLost = false
    const captured = this.settings.audioOnly ? [] : this.canvas.captureStream(15).getVideoTracks()
    const output = this.settings.audioOnly ? this.stream : new MediaStream([...captured, ...this.stream.getAudioTracks()])
    const mimeType = recordingFormat(MediaRecorder, this.settings.audioOnly)
    let recorder
    let result
    try {
      recorder = new MediaRecorder(output, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 1200000, audioBitsPerSecond: 64000 })
      result = new Promise((resolve, reject) => {
        const finish = next => {
          // The handlers hold this take's promise and Blob; drop them so a later prepare() frees it.
          // Events from a take already given up then go nowhere.
          clearTimeout(this.finishTimer); this.giveUp = null
          recorder.ondataavailable = recorder.onerror = recorder.onstop = null
          this.chunks = []; this.deviceLost = false; ++this.generation; this.release(); if (this.state !== 'disposed') this.setState(next)
        }
        // In WebKit, a take stopped moments after it starts can leave MediaRecorder silent: neither
        // stop nor error ever fires. stop() starts this; without a stop event in time, the take is
        // given up rather than left finishing forever. Nothing it recorded is kept.
        this.giveUp = () => {
          const cancelled = this.state === 'disposed'
          const error = cancelled ? new DOMException('The recording was cancelled.', 'AbortError') : new Error(this.deviceLost ? disconnected : unfinished)
          reject(error)
          try { if (!cancelled) this.onError(error) } finally { finish('idle') }
        }
        recorder.ondataavailable = ({ data }) => {
          if (data.size) { this.chunks.push(data); this.bytes += data.size }
          if (this.bytes >= 75000000 && this.state === 'recording') this.stop()
        }
        // After a MediaRecorder error, such as an encoder failure, what was recorded may be cut
        // short or unplayable. Like a take given up above, it ends at once with nothing kept,
        // during the take or while it finishes.
        recorder.onerror = () => {
          // A take ended by dispose() was abandoned, whatever its MediaRecorder reports afterwards.
          const cancelled = this.state === 'disposed'
          reject(cancelled ? new DOMException('The recording was cancelled.', 'AbortError') : new Error('Recording failed. Please retake the clip.'))
          try { if (!cancelled) this.onError(new Error('Recording failed.')) } finally { finish('idle') }
        }
        recorder.onstop = () => {
          // MediaRecorder also stops by itself once every recorded track has ended (an audio-only take).
          const lost = this.deviceLost || this.state === 'recording'
          let next = 'review'
          let explanation = null
          try {
            // A take ended by dispose() was abandoned, even though its data arrived.
            if (this.state === 'disposed') throw new DOMException('The recording was cancelled.', 'AbortError')
            const type = recorder.mimeType || (this.chunks[0] && this.chunks[0].type) || mimeType
            const blob = new Blob(this.chunks, { type })
            if (!blob.size && lost) { next = 'idle'; throw new Error(disconnected) }
            if (!blob.size) throw new Error('The recording was empty. Please try again.')
            resolve({ blob, mimeType: type, extension: extensionFor(type), durationMs: performance.now() - this.started })
            // A lost device keeps the partial take: the student reviews it and can still record again.
            if (lost) explanation = new Error('Your camera or microphone stopped. Review what was recorded, or record again.')
          } catch (error) {
            reject(error)
            if (next === 'idle') explanation = error
          }
          // Outside the try, so the catch above cannot mistake an exception from onError for the take's own failure and hide it.
          try { if (explanation) this.onError(explanation) } finally { finish(next) }
        }
      })
      // A consumer may await stop later; avoid an unhandled rejection in the meantime.
      result.catch(() => {})
      recorder.start(1000)
    } catch (error) {
      // Stay in preview: stop only the canvas capture made for this attempt, not the camera or microphone.
      captured.forEach(track => track.stop())
      throw error
    }
    this.recorder = recorder
    this.output = output
    this.result = result
    this.started = performance.now()
    this.setState('recording')
    this.limitTimer = setTimeout(() => this.stop(), 300000)
    return result
  }

  stop () {
    if (this.state === 'recording') {
      this.setState('finalizing')
      this.finishTimer = setTimeout(this.giveUp, FINISH_TIMEOUT_MS)
      if (this.recorder.state !== 'inactive') this.recorder.stop()
    }
    if (this.result) return this.result
    const none = Promise.reject(new DOMException('No recording has been started.', 'InvalidStateError'))
    none.catch(() => {})
    return none
  }

  trackEnded () {
    // During a take, keep what was recorded; onstop explains once it knows whether any data arrived.
    if (this.state === 'recording') { this.deviceLost = true; this.stop() } else this.fail(new Error(disconnected))
  }

  fail (error) {
    // Once a take is ending, its promise reports what matters. A late effect error from a
    // frame drawn before MediaRecorder stops must not replace the explanation already given.
    if (this.state === 'finalizing' || this.state === 'disposed') return
    // An onError that throws must not leave a take recording or the camera on; its exception still reaches the page.
    try { this.onError(error) } finally {
      if (this.state === 'recording') this.stop()
      else {
        ++this.generation
        this.releaseEffects()
        if (this.stream && this.stream.getTracks().every(track => track.readyState === 'live')) this.setState('setup-error')
        else { this.release(); this.setState('idle') }
      }
    }
  }

  releaseEffects () {
    clearInterval(this.timer)
    if (this.imageLoad) this.imageLoad.abort()
    this.imageLoad = null
    if (this.processor) this.processor.close()
    this.processor = null
    if (this.backgroundImage) this.backgroundImage.close()
    this.backgroundImage = null
    this.busy = false
    this.stage = null
    if (this.canvas) this.canvas.getContext('2d').clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  release () {
    this.releaseEffects()
    clearTimeout(this.limitTimer)
    for (const stream of [this.stream, this.output]) {
      if (stream) stream.getTracks().forEach(track => { track.onended = null; track.stop() })
    }
    this.stream = null
    this.output = null
    this.video.srcObject = null
  }

  dispose () {
    if (this.state === 'disposed') return
    if (this.state === 'recording') this.stop()
    ++this.generation
    this.setState('disposed')
    this.release()
    this.video.remove()
    document.removeEventListener('visibilitychange', this.visibility)
  }
}
