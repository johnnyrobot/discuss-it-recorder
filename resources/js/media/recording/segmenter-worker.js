/* global importScripts */
// Classic worker is deliberate: MediaPipe's WASM loader uses importScripts.
// Runtime assets sit beside this script, so hosts may serve them from any directory. When
// they are on another origin, the recorder starts this script from a blob: bootstrap, whose
// location says nothing about them, so the bootstrap names their directory instead.
const assetBase = self.discussItAssetBase || self.location.href
const asset = name => new URL(name, assetBase).href
self.exports = {}
importScripts(asset('vision_bundle.js'))
let segmenter
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const vision = self.exports
      const files = await vision.FilesetResolver.forVisionTasks(asset('wasm'))
      segmenter = await vision.ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetPath: asset('selfie_segmenter.tflite'), delegate: 'CPU' },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true
      })
      self.postMessage({ ready: true })
    } else {
      try {
        segmenter.segmentForVideo(data.frame, data.timestamp, result => {
          // Selfie segmenter exposes one confidence mask: confidence of person.
          const mask = result.confidenceMasks[0]
          const values = mask.getAsFloat32Array().slice()
          self.postMessage({ width: mask.width, height: mask.height, values: values.buffer }, [values.buffer])
        })
      } finally { data.frame.close() }
    }
  } catch (error) { self.postMessage({ error: 'Background processing is unavailable. Try again or choose None before recording.' }) }
}
