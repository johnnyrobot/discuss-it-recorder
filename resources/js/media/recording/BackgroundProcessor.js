// Background failures must never revoke camera access or expose a raw frame.
const appleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const unavailable = () => new Error('Background effects could not start. Tap Retry preview, or explicitly select None. Your camera permission does not need to be changed.')
const interrupted = () => new Error('The background effect stopped responding, so recording stopped. Review your clip, or record it again.')

export default class BackgroundProcessor {
  constructor (assetBase) {
    // The worker, module, WASM and model all load from this one host-chosen directory. An
    // unset (null or empty) value means the default. MediaPipe appends file names to the
    // WASM directory, so a query string or fragment cannot apply and is dropped.
    const assets = new URL(assetBase || '/assets/discuss-it/', document.baseURI)
    assets.search = ''
    assets.hash = ''
    if (!assets.pathname.endsWith('/')) assets.pathname += '/'
    this.assets = assets.href
  }

  async init () {
    this.closed = false
    // iOS browser apps share platform-specific capture/WebGL constraints. Use a
    // DOM canvas here rather than relying on worker OffscreenCanvas support.
    if (appleMobile()) return this.initMain()
    let bootstrap
    try {
      const worker = `${this.assets}segmenter-worker.js`
      if (new URL(worker).origin === location.origin) this.worker = new Worker(worker)
      else {
        // Browsers start a worker only from the page's own origin. For a directory on another
        // origin the host controls, such as its asset CDN, a same-origin blob: script tells
        // the worker its directory and loads it from there.
        bootstrap = URL.createObjectURL(new Blob([`self.discussItAssetBase = ${JSON.stringify(this.assets)}\nimportScripts(${JSON.stringify(worker)})\n`], { type: 'text/javascript' }))
        this.worker = new Worker(bootstrap)
      }
      await this.request({ type: 'init' }, [], 45000)
    } catch (error) {
      this.stopWorker()
      if (this.closed) throw error
      await this.initMain()
    } finally {
      if (bootstrap) URL.revokeObjectURL(bootstrap)
    }
  }

  async initMain () {
    if (this.closed) throw unavailable()
    let timeout
    try {
      const load = async () => {
        const vision = await import(/* webpackIgnore: true */ /* @vite-ignore */ `${this.assets}vision_module.js`)
        if (this.closed) throw unavailable()
        const files = await vision.FilesetResolver.forVisionTasks(`${this.assets}wasm`)
        if (this.closed) throw unavailable()
        const model = await vision.ImageSegmenter.createFromOptions(files, {
          canvas: document.createElement('canvas'),
          baseOptions: { modelAssetPath: `${this.assets}selfie_segmenter.tflite`, delegate: 'CPU' },
          runningMode: 'VIDEO',
          outputCategoryMask: false,
          outputConfidenceMasks: true
        })
        if (this.closed) { model.close(); throw unavailable() }
        this.model = model
      }
      await Promise.race([load(), new Promise((resolve, reject) => { timeout = setTimeout(() => reject(unavailable()), 45000) })])
    } catch (error) { this.close(); throw unavailable() } finally { clearTimeout(timeout) }
  }

  request (data, transfer, milliseconds) {
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        clearTimeout(timeout)
        this.cancelRequest = null
        if (error) reject(error); else resolve(result)
      }
      const timeout = setTimeout(() => finish(unavailable()), milliseconds)
      this.cancelRequest = () => finish(unavailable())
      this.worker.onmessage = ({ data }) => finish(data.error ? unavailable() : null, data)
      this.worker.onerror = () => finish(unavailable())
      try { this.worker.postMessage(data, transfer) } catch (error) { finish(unavailable()) }
    })
  }

  // recover() is asked only when the worker fails, so the caller can answer for that moment.
  async mask (canvas, timestamp, { recover = () => true } = {}) {
    if (this.closed) throw unavailable()
    if (this.worker) {
      let frame
      try {
        frame = await createImageBitmap(canvas)
        if (this.closed) { frame.close(); throw unavailable() }
        return await this.request({ type: 'frame', frame, timestamp }, [frame], 10000)
      } catch (error) {
        if (frame) frame.close()
        this.stopWorker()
        if (this.closed) throw error
        // Reloading on the main thread can freeze frames for up to 45 s. During a
        // take, stop with an explanation instead of recording a frozen picture.
        if (!recover()) throw interrupted()
        this.recovering = true
        try { await this.initMain() } finally { this.recovering = false }
      }
    }
    if (!this.model || this.closed) throw unavailable()
    let mask
    this.model.segmentForVideo(canvas, timestamp, result => {
      const confidence = result.confidenceMasks[0]
      mask = { width: confidence.width, height: confidence.height, values: confidence.getAsFloat32Array().slice().buffer }
    })
    return mask
  }

  stopWorker () {
    if (this.cancelRequest) this.cancelRequest()
    if (this.worker) this.worker.terminate()
    this.worker = null
  }

  close () {
    this.closed = true
    this.stopWorker()
    if (this.model) this.model.close()
    this.model = null
  }
}
