// Writes the demo as a static site, which GitHub Pages serves (.github/workflows/pages.yml).
// Run `npm run build` first: it stages the MediaPipe assets the site includes.
// Usage: node scripts/build-demo.mjs [directory], by default _site.
import fs from 'node:fs'
import path from 'node:path'
import { pages, files, directories } from './demo-site.mjs'
const root = process.cwd()
const out = path.resolve(process.argv[2] || '_site')
if (root === out || root.startsWith(out + path.sep)) throw Error(`Refusing to replace ${out}, which holds this repo`)
if (!fs.existsSync('public/assets/discuss-it/manifest.json')) throw Error('No staged assets: run npm run build first')
fs.rmSync(out, { recursive: true, force: true })
const write = (sitePath, content) => { fs.mkdirSync(path.dirname(path.join(out, sitePath)), { recursive: true }); fs.writeFileSync(path.join(out, sitePath), content) }
for (const [sitePath, content] of Object.entries(pages)) write(sitePath, content)
for (const [sitePath, file] of Object.entries(files)) write(sitePath, fs.readFileSync(file))
for (const [sitePath, directory] of Object.entries(directories)) fs.cpSync(directory, path.join(out, sitePath), { recursive: true })
console.log(`Demo site written to ${out}`)
