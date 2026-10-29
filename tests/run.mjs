// The one list of test variants. With no arguments it runs every variant, as
// `npm run test:all` does; `node tests/run.mjs webkit iphone` runs named ones, as
// the other package.json scripts do. KEY=value arguments add environment settings on
// any shell, to named variants or to test files given directly:
// `node tests/run.mjs BACKGROUND=none webkit` or `node tests/run.mjs BROWSER=webkit file.mjs`.
// Test settings come only from the arguments and this list, so flags exported in the
// caller's shell cannot silently change what a variant runs.
import { spawnSync } from 'node:child_process'
const settings = ['BROWSER', 'IPHONE', 'FAIL_WORKER', 'FAIL_ENUMERATION', 'IMAGE', 'BACKGROUND', 'DEMO_URL', 'CROSS_ORIGIN']
const variants = {
  'no-telemetry': ['tests/discuss-it/no-telemetry.mjs'],
  photos: ['tests/discuss-it/background-image.mjs'],
  'photos:chromium': ['BROWSER=chromium', 'tests/discuss-it/background-image.mjs'],
  recorder: ['tests/discuss-it/recorder-browser.mjs'],
  webkit: ['BROWSER=webkit', 'tests/discuss-it/recorder-browser.mjs'],
  iphone: ['IPHONE=1', 'tests/discuss-it/recorder-browser.mjs'],
  'worker-failure': ['FAIL_WORKER=1', 'tests/discuss-it/recorder-browser.mjs'],
  'enumeration-failure': ['FAIL_ENUMERATION=1', 'tests/discuss-it/recorder-browser.mjs'],
  'cross-origin': ['CROSS_ORIGIN=1', 'tests/discuss-it/recorder-browser.mjs'],
  'cross-origin:webkit': ['BROWSER=webkit', 'CROSS_ORIGIN=1', 'tests/discuss-it/recorder-browser.mjs'],
  'cross-origin:iphone': ['IPHONE=1', 'CROSS_ORIGIN=1', 'tests/discuss-it/recorder-browser.mjs'],
  ui: ['tests/discuss-it/iphone-recovery.mjs'],
  'ui:photo': ['IMAGE=1', 'tests/discuss-it/iphone-recovery.mjs'],
  'ui:decoder': ['IMAGE=decoder', 'tests/discuss-it/iphone-recovery.mjs'],
  demo: ['tests/demo.mjs'],
  'demo:site': ['tests/demo-site.mjs'],
  'demo:site:webkit': ['BROWSER=webkit', 'tests/demo-site.mjs']
}
const isSetting = arg => /^[A-Z_]+=/.test(arg)
const args = process.argv.slice(2)
const extra = args.filter(isSetting)
const files = args.filter(arg => !isSetting(arg) && !variants[arg])
const runs = args.filter(arg => variants[arg]).map(name => [...variants[name], ...extra])
if (files.length) runs.push([...extra, ...files])
if (!args.length) runs.push(...Object.values(variants))
if (!runs.length) {
  console.error(`No test file or variant given in: ${args.join(' ')}\nUsage: node tests/run.mjs [KEY=value ...] [variant | file.mjs ...]\nVariants: ${Object.keys(variants).join(', ')}`)
  process.exit(2)
}
for (const run of runs) {
  const env = { ...process.env }
  for (const name of settings) delete env[name]
  const testFiles = []
  for (const arg of run) {
    const setting = /^([A-Z_]+)=(.*)$/.exec(arg)
    if (setting) env[setting[1]] = setting[2]
    else testFiles.push(arg)
  }
  for (const file of testFiles) {
    console.log(`\n> ${run.join(' ')}`)
    const { status } = spawnSync(process.execPath, [file], { env, stdio: 'inherit' })
    if (status !== 0) process.exit(status ?? 1)
  }
}
