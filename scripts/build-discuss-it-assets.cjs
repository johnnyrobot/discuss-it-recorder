const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const root = path.resolve(__dirname, '..')
const target = path.join(root, 'public/assets/discuss-it')
fs.mkdirSync(target, { recursive: true })
fs.copyFileSync(path.join(root, 'resources/vendor/discuss-it/LICENSE'), path.join(target, 'LICENSE.txt'))
const model = fs.readFileSync(path.join(root, 'resources/vendor/discuss-it/selfie_segmenter.tflite'))
if (crypto.createHash('sha256').update(model).digest('hex') !== '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b') throw new Error('Segmentation model checksum mismatch')
fs.copyFileSync(path.join(root, 'resources/vendor/discuss-it/selfie_segmenter.tflite'), path.join(target, 'selfie_segmenter.tflite'))
fs.copyFileSync(path.join(root, 'resources/js/media/recording/segmenter-worker.js'), path.join(target, 'segmenter-worker.js'))
fs.copyFileSync(path.join(root, 'node_modules/@mediapipe/tasks-vision/vision_bundle.cjs'), path.join(target, 'vision_bundle.js'))
fs.copyFileSync(path.join(root, 'node_modules/@mediapipe/tasks-vision/vision_bundle.mjs'), path.join(target, 'vision_module.js'))
// The *_module_internal files are only for FilesetResolver.forVisionTasks(base, true), which the recorder never uses.
fs.cpSync(path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm'), path.join(target, 'wasm'), { recursive: true, filter: source => !path.basename(source).includes('_module_internal') })
const files = []
function walk (directory) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name)
    if (fs.statSync(file).isDirectory()) walk(file)
    else if (name !== 'manifest.json') files.push({ path: path.relative(target, file), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })
  }
}
walk(target)
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@mediapipe/tasks-vision/package.json'), 'utf8'))
fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ package: '@mediapipe/tasks-vision', version, license: 'Apache-2.0', files }, null, 2))
