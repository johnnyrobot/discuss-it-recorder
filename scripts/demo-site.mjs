// The demo's pages and files, shared by the local server (scripts/demo.mjs) and the static
// build for GitHub Pages (scripts/build-demo.mjs). No login, API, upload or persistent storage.
// Every URL is relative, so the demo works at any path, such as Pages' /discuss-it-recorder/.
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
const component = fs.readFileSync('resources/js/components/recording/VideoRecorder.vue', 'utf8')
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const commit = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() || 'unknown'

const script = component.match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace("'../../media/recording/Recorder'", "'./resources/js/media/recording/Recorder.js'")
  .replace("'../../media/recording/BackgroundImage.js'", "'./resources/js/media/recording/BackgroundImage.js'")
  .replace('export default', 'const component =')

// Generated pages, by their path in the site.
export const pages = {
  // `?audio` opens an audio-only recorder. The runtime assets load from the demo's own directory.
  'index.html': `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Discuss-It recorder demo</title><link rel="stylesheet" href="demo.css"><main><h1>Discuss-It recorder</h1><p class="version">Recorder v${version} · commit ${commit}</p><p>This demo records on your device. Nothing is uploaded. Download a copy before leaving.</p><nav class="modes" aria-label="Recording type"><a href="./">Video</a> · <a href="?audio">Audio only</a></nav><div id="app"></div></main><script type="module">import Vue from "./vue.js"; import Recorder from "./component.js"; const audioOnly = new URLSearchParams(location.search).has("audio"); document.querySelectorAll(".modes a")[audioOnly ? 1 : 0].setAttribute("aria-current", "page"); new Vue({render:h=>h(Recorder,{props:{audioOnly,assetBase:"assets/discuss-it/"}})}).$mount("#app")</script></html>`,
  'component.js': `${script}\ncomponent.template=${JSON.stringify(component.match(/<template>([\s\S]*?)<\/template>/)[1])};export default component;`,
  'demo.css': 'html{font:16px system-ui}body{margin:0;padding:16px}*{box-sizing:border-box}main{max-width:760px;margin:auto}button,select,input{font:inherit}button,a.btn{padding:10px;border:1px solid #64748b;border-radius:5px}a{color:#1255a0}.alert{padding:12px;background:#fff0c2}.version{color:#475569}.modes a[aria-current]{color:inherit;font-weight:bold;text-decoration:none}' + component.match(/<style scoped>([\s\S]*?)<\/style>/)[1]
}

// Files served as they are: a path in the site, then the file in this repo.
export const files = { 'vue.js': 'node_modules/vue/dist/vue.esm.browser.js' }
// Directories served as they are. `npm run build` stages the MediaPipe assets.
export const directories = { 'resources/js/media/recording': 'resources/js/media/recording', 'assets/discuss-it': 'public/assets/discuss-it' }

// The file in this repo for a path in the site, or null when the site has no such file.
export function source (sitePath) {
  if (Object.hasOwn(files, sitePath)) return files[sitePath]
  const directory = Object.keys(directories).find(name => sitePath.startsWith(`${name}/`))
  return directory ? directories[directory] + sitePath.slice(directory.length) : null
}
