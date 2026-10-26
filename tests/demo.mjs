import { once } from 'node:events'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
process.env.PORT = '0'
const { default: server } = await import('../scripts/demo.mjs')
if (!server.listening) await once(server, 'listening')
// Paths named after built-in object keys are neither pages nor files, and must not stop the server.
for (const name of ['constructor', '__proto__', 'toString']) assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/${name}`)).status, 404, `/${name} must be a 404`)
const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  const writes = []; page.on('request', request => { if (request.method() !== 'GET') writes.push(request.method()) })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('combobox', { name: /^Background/ }).selectOption('blur')
  await page.getByRole('button', { name: 'Enable camera & microphone', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).click({ timeout: 60000 })
  await page.waitForTimeout(1600)
  await page.getByRole('button', { name: 'Stop & review', exact: true }).click()
  await page.getByRole('link', { name: 'Download a copy', exact: true }).waitFor()
  assert.ok(await page.getByLabel('Review recording', { exact: true }).evaluate(async video => { video.muted = true; await video.play(); return video.videoWidth > 0 }))
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2))
  // A take cancelled while recording is discarded, not offered for review or download.
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Retake', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).click({ timeout: 60000 })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.waitForTimeout(1500)
  assert.equal(await page.getByRole('link', { name: 'Download a copy', exact: true }).count(), 0, 'A cancelled take is not offered for download')
  assert.equal(await page.getByRole('alert').count(), 0, 'Cancelling is not an error')
  assert.deepEqual(errors, []); assert.deepEqual(writes, [])
  console.log('PASS standalone demo renders, records, reviews, discards a cancelled take and fits a phone without any upload')
} finally { await browser.close(); server.close() }
