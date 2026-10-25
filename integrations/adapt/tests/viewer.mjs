// ARCHIVED: reference only, kept with the archived feature.patch and not maintained.
// It checks the patched viewer's prompt, API calls and UI, so it fails against current
// upstream ADAPT, whose own DiscussItViewer.vue is a different component. That failure
// is expected; this is not a validation step. See integrations/adapt/README.md.
// Browser checks for the patched DiscussItViewer: prompt sanitizing, expired-upload
// recovery and stalled-upload handling. Run from the ADAPT checkout root after
// applying the patch and installing dompurify. Uses the host's own Vue 2, axios (0.21
// or 1.x) with its interceptors from resources/js/plugins/axios.js, and DOMPurify;
// stub recorder/comment components, store, router and alerts; and a mocked API: no
// accounts, server writes, uploads, camera or microphone.
import http from 'node:http'
import fs from 'node:fs'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const component = fs.readFileSync('resources/js/components/viewers/DiscussItViewer.vue', 'utf8')
// The app registers its interceptors on the shared axios instance; load them with stub dependencies.
const pluginImports = { axios: '/axios-real.js', '~/store': '/store.js', '~/router': '/router.js', sweetalert2: '/alerts.js', '~/plugins/i18n': '/i18n.js' }
const plugin = fs.readFileSync('resources/js/plugins/axios.js', 'utf8').replace(/from '([^']+)'/g, (statement, name) => {
  if (!pluginImports[name]) throw new Error(`resources/js/plugins/axios.js imports ${name}; add a stub for it to this test`)
  return `from '${pluginImports[name]}'`
})
const modules = {
  '/vue.js': fs.readFileSync('node_modules/vue/dist/vue.esm.browser.js', 'utf8'),
  // The browser build exists in every axios version; axios 0.21 has no ES module build.
  '/axios-browser.js': fs.readFileSync('node_modules/axios/dist/axios.js', 'utf8'),
  '/axios-real.js': 'export default window.axios',
  '/axios-plugin.js': plugin,
  '/store.js': "export default { getters: { 'auth/token': 'test-token', 'lang/locale': 'en', 'auth/check': true }, commit () {} }",
  '/router.js': 'export default { push () {} }',
  '/alerts.js': 'export default { fire: options => { (window.alerts = window.alerts || []).push(options.title); return Promise.resolve({}) } }',
  '/i18n.js': 'export default { t: key => key }',
  // Real axios, except a check may install window.fakePut to drive upload progress on the fake clock.
  '/axios.js': "import real from '/axios-real.js'\nexport default Object.assign(Object.create(real), { put: (...args) => (window.fakePut || real.put)(...args) })",
  '/dompurify.js': fs.readFileSync('node_modules/dompurify/dist/purify.es.mjs', 'utf8'),
  '/uuid.js': 'export const v4 = () => crypto.randomUUID()',
  // Like the real recorder, unmounting with a take emits recorded(null).
  '/VideoRecorder.js': "export default { template: '<button type=\"button\" @click=\"record\">Fake record</button>', methods: { record () { this.taken = true; this.$emit('recorded', { blob: new Blob([new Uint8Array(3000000)], { type: 'video/webm' }), extension: 'webm' }) } }, beforeDestroy () { if (this.taken) this.$emit('recorded', null) } }",
  '/DiscussItComment.js': "export default { props: ['comment', 'base'], template: '<p>{{ comment.text }}</p>' }",
  '/Viewer.js': component.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace("from 'axios'", "from '/axios.js'").replace("from 'dompurify'", "from '/dompurify.js'").replace("from 'uuid'", "from '/uuid.js'")
    .replace("from '../recording/VideoRecorder'", "from '/VideoRecorder.js'").replace("from './DiscussItComment'", "from '/DiscussItComment.js'")
    .replace('export default', 'const component =') + `\ncomponent.template = ${JSON.stringify(component.match(/<template>([\s\S]*?)<\/template>\s*<script>/)[1])}; export default component`
}
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><div id="app"></div><script src="/axios-browser.js"></script><script type="module">import "/axios-plugin.js"; import Vue from "/vue.js"; import Viewer from "/Viewer.js"; window.app = new Vue({ render: h => h(Viewer, { props: { assignmentId: 1, questionId: 2 } }) }).$mount("#app")</script>'); return }
  if (modules[req.url]) { res.setHeader('Content-Type', 'application/javascript'); res.end(modules[req.url]); return }
  res.writeHead(404); res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true })
const settings = { enabled: true, min_threads: 1, min_replies: 0, min_words: 1, min_seconds: 0, auto_grade: false, allow_edit: true, allow_delete: true, group_by_section: false }
const prompt = '<p id="prompt-text">Introduce <strong>yourself</strong></p><img id="pixel" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onerror="window.pwned = 1"><script>window.pwned = 2</script><a id="bad-link" href="javascript:window.pwned=3">link</a><svg><script>window.pwned = 4</script></svg>' +
  '<iframe id="video" src="/embedded-video" width="320" height="180" frameborder="0" allowfullscreen></iframe><a id="new-window" href="https://example.org/" target="_blank">reading</a><iframe id="inline-page" srcdoc="<script>parent.pwned = 5</script>"></iframe>'
const index = { json: { owner: false, settings, comments: [], completion: { threads: 0, replies: 0, complete: false }, prompt, title: 'Test' } }
async function check (name, handlers, steps, { init, clock } = {}) {
  const page = await browser.newPage()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  const calls = []
  const withoutInterceptors = []
  await page.route('**/api/discuss-it/**', async route => {
    const request = route.request()
    const call = `${request.method()} ${new URL(request.url()).pathname.replace('/api/discuss-it/1/2', '') || '/'}`
    if (call !== 'GET /') calls.push(call)
    if (request.headers().authorization !== 'Bearer test-token') withoutInterceptors.push(call)
    const reply = typeof handlers[call] === 'function' ? handlers[call]() : handlers[call]
    if (reply === 'stall') return // Never answer, like a connection that stopped moving.
    await route.fulfill(reply ? { status: reply.status || 200, json: reply.json || {} } : { status: 500, json: { message: `Unexpected ${call}` } })
  })
  if (init) await page.addInitScript(init)
  if (clock) await page.clock.install()
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await steps(page, calls)
  assert.deepEqual(errors, [], `${name}: no page errors`)
  assert.deepEqual(withoutInterceptors, [], `${name}: requests go through the app's axios interceptors`)
  await page.close()
  console.log(`PASS ${name}`)
}
const compose = async page => {
  await page.getByRole('button', { name: 'Start a thread' }).click()
  await page.getByRole('button', { name: 'Fake record' }).click()
  await page.getByText('Attached: recording.webm').waitFor()
  await page.getByRole('button', { name: 'Submit response' }).click()
}
const tickets = prefix => { let count = 0; return () => ({ json: { id: `${prefix}${++count}`, url: `/api/discuss-it/1/2/media/${prefix}${count}/content` } }) }
// A PUT that reports progress every 30 s of fake time for `steps` of 14 steps,
// honouring axios' timeout and cancel token the way the real adapter does.
const fakeUpload = steps => `window.fakePut = (url, data, config) => new Promise((resolve, reject) => {
  let cancelled = false
  if (config.timeout) setTimeout(() => reject(new Error('timeout of ' + config.timeout + 'ms exceeded')), config.timeout)
  if (config.cancelToken) config.cancelToken.promise.then(reason => { cancelled = true; reject(reason) })
  let step = 0
  const tick = () => {
    if (cancelled) return
    const loaded = Math.round(data.size * ++step / 14)
    if (config.onUploadProgress) config.onUploadProgress({ loaded, total: data.size })
    if (loaded >= data.size) setTimeout(() => resolve({ status: 200, data: { uploaded: true } }), 1000)
    else if (step < ${steps}) setTimeout(tick, 30000)
  }
  setTimeout(tick, 30000)
})`
try {
  await check('prompt HTML is sanitized but keeps its formatting', { 'GET /': index }, async page => {
    await page.locator('#prompt-text strong').waitFor()
    await page.waitForTimeout(300)
    assert.equal(await page.evaluate(() => window.pwned), undefined, 'no author script ran')
    assert.equal(await page.locator('.discuss-it script').count(), 0, 'no script elements rendered')
    assert.equal(await page.locator('#pixel').getAttribute('onerror'), null, 'event handler attributes removed')
    assert.ok(!String(await page.locator('#bad-link').getAttribute('href')).startsWith('javascript:'), 'javascript: links removed')
    assert.equal(await page.locator('#video').getAttribute('src'), '/embedded-video', 'embedded videos are kept')
    assert.equal(await page.locator('#video').getAttribute('allowfullscreen'), '', 'embedded videos can go full screen')
    assert.equal(await page.locator('#new-window').getAttribute('target'), '_blank', 'links that open a new window keep their target')
    assert.equal(await page.locator('#inline-page[srcdoc]').count(), 0, 'inline frame documents are removed')
  })
  await check('an expired upload (410 from the PUT) starts one fresh upload', {
    'GET /': index, 'POST /uploads': tickets('m'),
    'PUT /media/m1/content': { status: 410, json: { message: 'Upload expired.' } },
    'PUT /media/m2/content': { json: { uploaded: true } },
    'POST /media/m2/finalize': { status: 202 }, 'GET /media/m2': { json: { status: 'ready' } }, 'POST /comments': { json: { id: 7 } }
  }, async (page, calls) => {
    await compose(page)
    await page.getByText('Response submitted.').waitFor()
    assert.deepEqual(calls, ['POST /uploads', 'PUT /media/m1/content', 'POST /uploads', 'PUT /media/m2/content', 'POST /media/m2/finalize', 'GET /media/m2', 'POST /comments'])
  })
  await check('an expired finalize (410) uploads again once', {
    'GET /': index, 'POST /uploads': tickets('f'),
    'PUT /media/f1/content': { json: { uploaded: true } },
    'POST /media/f1/finalize': { status: 410, json: { message: 'Upload expired. Please upload again.' } },
    'PUT /media/f2/content': { json: { uploaded: true } },
    'POST /media/f2/finalize': { status: 202 }, 'GET /media/f2': { json: { status: 'ready' } }, 'POST /comments': { json: { id: 8 } }
  }, async (page, calls) => {
    await compose(page)
    await page.getByText('Response submitted.').waitFor()
    assert.deepEqual(calls, ['POST /uploads', 'PUT /media/f1/content', 'POST /media/f1/finalize', 'POST /uploads', 'PUT /media/f2/content', 'POST /media/f2/finalize', 'GET /media/f2', 'POST /comments'])
  })
  await check('a second expiry in one submit is reported instead of retried again', {
    'GET /': index, 'POST /uploads': tickets('g'),
    'PUT /media/g1/content': { status: 410, json: { message: 'Upload expired.' } },
    'PUT /media/g2/content': { status: 410, json: { message: 'Upload expired.' } }
  }, async (page, calls) => {
    await compose(page)
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByRole('alert').innerText(), 'Upload expired.')
    assert.equal(calls.filter(call => call.startsWith('PUT')).length, 2)
  })
  const media = { 'GET /': index, 'POST /uploads': tickets('s'), 'POST /media/s1/finalize': { status: 202 }, 'GET /media/s1': { json: { status: 'ready' } }, 'POST /comments': { json: { id: 9 } } }
  await check('a 7-minute upload that keeps making progress is not cut off', media, async page => {
    await compose(page)
    await page.getByText(/^Uploading recording/).waitFor()
    for (let i = 0; i < 16; i++) await page.clock.fastForward(30000)
    await page.getByText('Response submitted.').waitFor({ timeout: 10000 }).catch(async () => { throw new Error(`Not submitted: ${await page.getByRole('alert').allInnerTexts()}`) })
  }, { init: fakeUpload(14), clock: true })
  await check('an upload that stops making progress is aborted with an explanation', media, async page => {
    await compose(page)
    await page.getByText(/^Uploading recording/).waitFor()
    await page.clock.fastForward(30000); await page.clock.fastForward(30000)
    await page.getByText('Uploading recording… 10%').waitFor()
    await page.clock.fastForward(55000)
    assert.equal(await page.getByRole('alert').count(), 0, 'not aborted within 60 s of the last progress')
    await page.clock.fastForward(10000)
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').innerText(), /stopped making progress/)
    assert.ok(await page.getByRole('button', { name: 'Submit response' }).isEnabled(), 'Submit is available to retry')
  }, { init: fakeUpload(2), clock: true })
  await check('a stalled upload is cancelled by the host\'s own axios', { 'GET /': index, 'POST /uploads': tickets('t'), 'PUT /media/t1/content': 'stall' }, async page => {
    await compose(page)
    await page.getByText(/^Uploading recording/).waitFor()
    for (let i = 0; i < 3 && !(await page.getByRole('alert').count()); i++) { await page.clock.fastForward(181000); await page.waitForTimeout(300) }
    await page.getByRole('alert').waitFor({ timeout: 5000 })
    assert.match(await page.getByRole('alert').innerText(), /stopped making progress/)
    assert.ok(await page.getByRole('button', { name: 'Submit response' }).isEnabled(), 'Submit is available to retry')
  }, { clock: true })
  await check('leaving the question mid-upload still finalizes the upload', { 'GET /': index, 'POST /uploads': tickets('n'), 'POST /media/n1/finalize': { status: 202 } }, async (page, calls) => {
    await compose(page)
    await page.getByText(/^Uploading recording/).waitFor()
    await page.clock.fastForward(30000)
    // Paging to another question destroys the viewer and its recorder mid-upload.
    await page.evaluate(() => window.app.$destroy())
    for (let i = 0; i < 15; i++) await page.clock.fastForward(30000)
    for (let i = 0; i < 50 && !calls.includes('POST /media/n1/finalize'); i++) await page.waitForTimeout(100)
    assert.deepEqual(calls, ['POST /uploads', 'POST /media/n1/finalize'], 'the completed upload is finalized, so it does not count as pending')
  }, { init: fakeUpload(14), clock: true })
} finally { await browser.close(); server.close() }
