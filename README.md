# Discuss-It recorder

Focused developer handoff for LibreTexts: **not an ADAPT fork and not a complete LMS**. This repo contains the reusable on-device recorder, a Vue 2 adapter, a no-login/no-upload demo, tests, and an archived ADAPT integration patch kept for reference. No ADAPT history, credentials, user data, recordings, or infrastructure configuration is included.

## Try it without ADAPT

Use Node.js 22.2 or newer:

```sh
npm ci
npm run build
npm run demo
```

Open `http://127.0.0.1:4173`. Allow camera/microphone, choose a look, record, review and download. The demo has **no Submit/upload function**. Localhost is a secure-context exception; to test on a real phone, use the hosted demo below or serve the demo through your own HTTPS setup. The server intentionally binds to loopback and is not a production server.

A hosted copy, built from `main`, is at <https://johnnyrobot.github.io/discuss-it-recorder/>. It shows the recorder version and the commit it was built from, and **Audio only** (`?audio`) opens the audio-only recorder. [`.github/workflows/pages.yml`](.github/workflows/pages.yml) builds it on every push to `main` with `npm run build:demo`, a static copy of the same demo, checks it, and publishes it with GitHub Pages. Like the local demo it uploads nothing and loads every file from its own site.

## What is reusable?

- `resources/js/media/recording/`: framework-independent browser ES modules. Capture, effect processing and encoding stay on-device.
- `resources/js/components/recording/VideoRecorder.vue`: optional legacy Vue 2 UI. It emits `busy`, `recording` and `recorded`; it does not know about users, courses or uploads. Vue 2 is used only by this adapter/demo; a Vue 3 or other UI can call the same core.
- `resources/vendor/discuss-it/`: pinned segmentation model, license and checksum. `npm run build` copies the installed MediaPipe runtime/WASM into `public/assets/discuss-it/`.
- `integrations/adapt/`: ADAPT integration notes and an archived discussion/question-type patch, separate from the recorder.

Front/rear switching, device selection, mirroring, blur, neutral color and custom-photo backgrounds are supported before each take. Effects are encoded into the saved recording. HEIC/HEIF needs native browser codec support; otherwise use JPG/PNG/WebP. Photos are limited to 20 MB/50 megapixels and normalized to at most 640 pixels per side. Video is approximately 15 fps, with five-minute and 75 MB local stop thresholds. Audio-only is supported.

## Integrate the recorder

See [the interface contract](docs/INTERFACE.md) and [ADAPT integration](integrations/adapt/README.md). Serve the runtime assets from the app's own origin or from an asset CDN the host controls: they load from `/assets/discuss-it/` unless you pass another directory as `assetBase`. If the host serves its built assets from a CDN (for example through Laravel's `ASSET_URL`), pass that directory, for example `https://assets.example.com/assets/discuss-it/`, and have the CDN send `Access-Control-Allow-Origin` on those files; without it, effects other than None cannot start. A Content-Security-Policy also needs `blob:` in `worker-src` for that case; the [interface contract](docs/INTERFACE.md) lists what else it must allow. The host app owns authentication, permissions, posting, storage, validation, grading and captions. Do not treat a browser-produced Blob as trusted server input.

```js
import Recorder from './resources/js/media/recording/Recorder.js'
const recorder = new Recorder(canvas, state => updateStatus(state), error => showError(error.message))
await recorder.prepare({ facingMode: 'user', mirror: true, background: 'blur' })
const completed = recorder.start()
// Later, from the Stop button:
recorder.stop()
const { blob, mimeType, extension, durationMs } = await completed
// Review locally; upload only after explicit user submission.
recorder.dispose() // Also call on navigation/unmount.
```

## Add it to LibreTexts ADAPT

LT's ADAPT (`master`) already has Discuss-It; the steps below add the recorder to it, and that is the supported path. `integrations/adapt/feature.patch` is archived: it adds a separate Discuss-It backend, viewer and question type built against a non-public ADAPT baseline from before Laravel 12, and it does not apply to `master`. See [ADAPT integration](integrations/adapt/README.md).

LT's Discuss-It records video and audio comments with `resources/js/components/NativeAudioVideoRecorder.vue` (last changed in `e33e6d3a9`, 2025-11-20). The same component records `submission` and `submitted-work` uploads, so one change covers all three.

1. Copy `resources/js/media/recording/`, `resources/js/components/recording/`, `resources/vendor/discuss-it/` and `scripts/build-discuss-it-assets.cjs`, add `@mediapipe/tasks-vision@0.10.35`, and serve the runtime assets as described above. When `ASSET_URL` sends ADAPT's built assets to a CDN, pass `asset-base` as that URL followed by `/assets/discuss-it/`.
2. In `NativeAudioVideoRecorder.vue`, replace the `getUserMedia`/`MediaRecorder` code in `startRecording()` and `stopRecording()` with `VideoRecorder.vue` (pass `audio-only` when `recordingType` is `audio`), or call `Recorder.js` directly.
3. Keep emitting `startVideoRecording` and `stopVideoRecording` when recording actually starts and stops: `DiscussItViewer.vue` uses them for the minimum-length countdown. Emit them from `VideoRecorder.vue`'s `recording` event (`true` when a take starts, `false` when it ends), not from `busy`, which is also true during the preview. If you call `Recorder.js` directly, use its `recording` state.
4. On `recorded`, keep the result until the student submits, then pass `result.blob` to the existing `uploadRecording()`. LT's pre-signed upload, storage, threads and permissions stay as they are.
5. Send `result.mimeType` and `result.extension` with the upload. The component currently labels every video `video/webm` and `temp.webm`, including MP4 that Safari records on iPhone.

## Tests and device status

```sh
npx playwright install chromium webkit
npm test
npm run test:ui
npm run test:demo
npm run test:demo:site
npm run test:all
```

`npm run test:all` runs every variant one after another. Each also has its own script: `test:no-telemetry` (the MediaPipe pin, and a scan of the shipped files for Google API hosts, Google's API key header and known analytics and logging endpoints; see [ADR 0001](docs/adr/0001-no-telemetry.md)), `test:photos:chromium`, `test:webkit`, `test:iphone` (iPhone user agent, main-thread effects), `test:worker-failure`, `test:enumeration-failure`, `test:cross-origin` (the runtime assets served only from a second local origin with CORS, as from a host's asset CDN, in Chromium, WebKit and the iPhone path, under the strictest Content-Security-Policy the interface contract allows, and from a copy without CORS, which must fail with the usual explanation and keep the camera), `test:ui:photo` (a photo over 5 MB as the background), `test:ui:decoder` (photo loading without `createImageBitmap`) and `test:demo:site` (the static demo served under `/discuss-it-recorder/` as GitHub Pages does, in Chromium and WebKit; `npm run test:demo:site -- DEMO_URL=https://johnnyrobot.github.io/discuss-it-recorder/` checks the hosted copy instead). All of them are defined once, in `tests/run.mjs`. `node tests/run.mjs KEY=value file.mjs` runs any test file with environment settings on any shell, and `node tests/run.mjs BACKGROUND=none webkit` adds settings to a named variant. Test settings come only from these arguments; ones exported in your shell are ignored.

Tests use synthetic media, not your camera, microphone or ADAPT accounts. On macOS, image tests generate a synthetic HEIC with `sips`; other systems skip that native-codec check. Browser automation is not a real iPhone hardware test.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every pull request and push to `main`. On Ubuntu it runs the build, `npm test` and the variants that record in Chromium. Playwright's Linux WebKit has no `MediaRecorder`, so a macOS job runs the full `npm run test:all`, including WebKit recording and the HEIC check. [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes the demo from `main`.

Reported physical-device results: Android Chrome works; iPhone Chrome front camera with Blur works. Custom-photo loading received a follow-up fix and passes `npm run test:ui:photo` and `npm run test:ui:decoder`; final physical-iPhone confirmation remains pending. See [validation and limitations](docs/VALIDATION.md).

## Sharing and licensing

This is a public source repository, not an npm package: `package.json` is marked private only so it cannot be published to npm by mistake. LT developers can use it without access to ADAPT. Report security issues as described in [SECURITY.md](SECURITY.md). Source includes the inherited MIT notice; MediaPipe runtime/model use Apache-2.0. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
