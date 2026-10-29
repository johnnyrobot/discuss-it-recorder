# Add the recorder to LibreTexts ADAPT

LibreTexts ADAPT already has Discuss-It. Its `resources/js/components/NativeAudioVideoRecorder.vue` records discussion comments, `submission` uploads and `submitted-work` uploads with its own `getUserMedia`/`MediaRecorder` code. This guide replaces that code with the recorder, so one change covers all three. The server side does not change: the pre-signed upload, storage, threads and permissions stay as they are.

Follow this guide from top to bottom in an ADAPT checkout. It was last checked on 2026-10-29 against ADAPT `master` at `1486f96c` (2026-10-27), with Node 22.20.0, Laravel Mix 4.1.4 and webpack 4.44.1 (see [validation](../../docs/VALIDATION.md)).

One ADAPT bug is outside this change. At `1486f96c`, the phone audio recorder in `resources/js/components/SubmitWork.vue` listens for `saveComment`, but `NativeAudioVideoRecorder.vue` has emitted `storeSubmittedWork` for `submitted-work` since `e33e6d3a`. A phone audio take of submitted work therefore uploads, but `SubmitWork.vue` never saves it. The patch does not touch `SubmitWork.vue`; fix that listener separately (`@storeSubmittedWork`, as its video recorder already uses).

## What changes in ADAPT

Copied unchanged from the v0.1.8 tag:

- `resources/js/components/recording/VideoRecorder.vue`, the Vue 2 adapter
- `resources/js/media/recording/`, the recorder
- `resources/vendor/discuss-it/`, the pinned segmentation model with its license and checksum
- `scripts/build-discuss-it-assets.cjs`, which stages the runtime in `public/assets/discuss-it/`

Edited by [`recorder.patch`](recorder.patch):

- `resources/js/components/NativeAudioVideoRecorder.vue` uses `VideoRecorder`, passes it the asset directory, and uploads only after **Submit recording**, with the recording's own MIME type and extension (Safari records MP4).
- `resources/js/components/viewers/DiscussItViewer.vue`: a retake resets the length requirement.
- `package.json` adds the `build:recorder-assets` and `test:recorder` scripts, runs `build:recorder-assets` before `development` and `production`, and adds `@mediapipe/tasks-vision` 0.10.35 and `playwright` 1.64.1.
- `.gitignore` ignores the generated `public/assets/discuss-it/`.
- `tests/Browser/native-recorder.mjs` is the browser check.
- `docs/recorder-integration.md` describes the integration for ADAPT developers.

The patch leaves out `package-lock.json`, which step 4 updates. At `1486f96c`, `NativeAudioVideoRecorder.vue` was last changed in `e33e6d3a` (2025-11-20) and `DiscussItViewer.vue` in `23be8615` (2026-10-20).

## 1. Before you start

- Use Node 22.2 or newer (`node --version`), the oldest version the recorder supports (`engines` in its `package.json`). The machine that runs the Vapor build needs it too, and so does any other build of ADAPT's front end. ADAPT's root `Dockerfile` installs Debian's Node 12 on `php:7.4-apache`, which is too old: update its Node before you build that image.
- Start on a new branch in a clean ADAPT checkout: `git status` shows nothing to commit.
- Get the recorder at the release tag:

```sh
ADAPT=/path/to/adapt
RECORDER="$(mktemp -d)/discuss-it-recorder"
git clone --depth 1 --branch v0.1.8 https://github.com/johnnyrobot/discuss-it-recorder.git "$RECORDER"
```

## 2. Copy the recorder files

```sh
git -C "$RECORDER" archive v0.1.8 \
  resources/js/components/recording \
  resources/js/media/recording \
  resources/vendor/discuss-it \
  scripts/build-discuss-it-assets.cjs | tar -x -C "$ADAPT"
```

`git -C "$ADAPT" status --short` now lists them as untracked.

## 3. Apply the ADAPT edits

```sh
cd "$ADAPT"
git apply --check "$RECORDER/integrations/adapt/recorder.patch"
git apply "$RECORDER/integrations/adapt/recorder.patch"
```

`--check` prints nothing when the patch applies. If it fails, `master` has changed one of the six files since `1486f96c`. Don't force it: compare the failing hunk with the current file and port it by hand, keeping the behaviour the patch's `docs/recorder-integration.md` describes.

## 4. Install the pinned runtime

```sh
npm install --save-exact @mediapipe/tasks-vision@0.10.35
```

This installs ADAPT's dependencies and the two the patch adds, and updates `package-lock.json`. Afterwards `git diff package.json` shows only the patch's changes. Keep the `package-lock.json` change: Vapor builds with `npm ci`, which fails when the lock does not match `package.json`. MediaPipe stays at exactly 0.10.35 under the recorder's [no-telemetry decision](../../docs/adr/0001-no-telemetry.md); do not upgrade it to 1.x.

## 5. Run the browser check

```sh
npx playwright install chromium webkit
npm run build:recorder-assets
npm run test:recorder
```

The check loads the runtime from `public/assets/discuss-it/`, so stage the assets first. It prints 44 `PASS` lines, 22 cases in each of Chromium and WebKit (listed in `docs/recorder-integration.md`), and exits 0. It uses synthetic capture and a local upload receiver: no ADAPT server, account, database, camera or object storage. Run it on macOS: Playwright's Linux WebKit has no `MediaRecorder`.

## 6. Build for production

```sh
npm run production
```

`production` stages the assets again before it builds. Then check:

- `public/assets/discuss-it/` holds `segmenter-worker.js`, `vision_bundle.js`, `vision_module.js`, `selfie_segmenter.tflite`, `LICENSE.txt`, `manifest.json` and a `wasm/` folder with `vision_wasm_internal.js`, `vision_wasm_internal.wasm`, `vision_wasm_nosimd_internal.js` and `vision_wasm_nosimd_internal.wasm`.
- `manifest.json` names version `0.10.35`.
- The build log's `Asset URL:` line, printed by `webpack.mix.js`, is `/` without `ASSET_URL`, or `ASSET_URL` followed by `/`.
- `grep -rho '"[^"]*assets/discuss-it/"' public/dist/js | sort -u` lists the asset directories in the bundle. Built with `ASSET_URL=https://assets.example.test`, it includes `"https://assets.example.test/assets/discuss-it/"`, the directory `NativeAudioVideoRecorder.vue` passes to the recorder. `"/assets/discuss-it/"` is always listed too: it is the recorder's own default. Built without `ASSET_URL`, that is the only line.

## 7. Commit

Commit the copied files, the patched files and `package-lock.json`. `public/assets/discuss-it/` is generated and ignored by Git.

Afterwards:

- Keep the copied files as they are. ADAPT's `npm run lint` fixes files under `resources/js` in place, so revert any change it makes to the copied recorder files.
- For live rebuilds use `npm run watch`: it runs `development`, which stages the assets. At `1486f96c`, `npm run hot` runs neither that hook nor the `--openssl-legacy-provider` option that `dev`, `watch` and `production` set.

## Deploy on Vapor

ADAPT's `vapor.yml` builds with `npm ci && npm run prod`. `prod` runs `production`, whose `preproduction` hook stages `public/assets/discuss-it/`, so the deploy needs no extra step. Vapor uploads `public/` to S3 and serves it from CloudFront at `ASSET_URL`, not from the app's own domain.

- **`ASSET_URL` must be set when the bundle is built.** Vapor sets it for the build. `webpack.mix.js` turns it into `process.env.ASSET_PATH`, and the recorder loads its runtime from `ASSET_URL` followed by `/assets/discuss-it/`. If it is not set, the recorder falls back to `/assets/discuss-it/` on the app's own domain, which Vapor does not serve, and every background but None fails with "Background effects could not start…". The build log's `Asset URL:` line shows the value used.
- **The build runs where `vapor deploy` runs**, on that machine or CI job, not on Lambda, so it needs Node 22.2 or newer.
- **Check the asset CDN on staging** before production:

```sh
APP_ORIGIN='https://<staging app host>'
ASSETS='<staging ASSET_URL>/assets/discuss-it'
for file in segmenter-worker.js wasm/vision_wasm_internal.wasm selfie_segmenter.tflite; do
  echo "$file"
  curl -s -o /dev/null -D - -H "Origin: $APP_ORIGIN" "$ASSETS/$file" | grep -iE '^(HTTP/|access-control-allow-origin|content-type)'
done
```

Each request is a GET, like the browser's. Expect status 200 and `access-control-allow-origin` (the app's origin or `*`) on all three, and `content-type: application/wasm` on the `.wasm`. Then sign in to staging, open a Discuss-It question and record one take with **Blur**: the preview blurs, and after **Submit recording** the take uploads and plays back.

- **If `access-control-allow-origin` is missing**, add a CORS response headers policy to the CloudFront distribution that serves `ASSET_URL` (the AWS managed `SimpleCORS` policy sends `*`), invalidate `/assets/discuss-it/*`, and run the check again. If the `.wasm` has another content type, set `application/wasm` at the CDN or bucket: with any other type the browser cannot compile it as it downloads, and MediaPipe falls back to a slower load.
- **Content-Security-Policy.** At `1486f96c` ADAPT sends one only for its sketcher page. If the deployment adds one for the app, it must allow the asset origin in `script-src` and `connect-src`, `'wasm-unsafe-eval'` in `script-src`, and `blob:` in `worker-src`.

**Not verified by us:** this section's Vapor and CloudFront behaviour. We have no Vapor project, and we have not checked LT's staging or production. The tests prove the cross-origin path only against a second local origin that sends CORS headers (`npm run test:cross-origin` here, and the cross-origin case of `npm run test:recorder` in ADAPT). The staging check above is for LT engineers to run.

## Archived: `feature.patch`

**`feature.patch` is archived. It is kept for reference only and is not maintained or rebased.** It was built against ADAPT commit `0345e96cc84c056dab9a6ab4efe1b322b7bcd79d`, which is in a non-public fork from before ADAPT moved to Laravel 12; that baseline ran PHP 7.4, Laravel 7.30.4 and Laravel Mix 6. It is not on LibreTexts/adapt, so the patch's apply check can only be reproduced from that fork. It will not apply to LT's current `master` (PHP 8.4 and Laravel 12 since `98f910391`, 2026-10-23, building with `laravel-mix ^4.1.4`): for example, it creates `resources/js/components/viewers/DiscussItViewer.vue`, which `master` already has as its own, much larger component.

The patch adds a separate discussion/question-type backend and UI: feature additions and narrow ADAPT edits. Read it for ideas, such as server-side media checks, private storage and signed playback, and port anything useful by hand. Do not apply it to `master` or overwrite current application files with it. The patched viewer also imports `dompurify` (checked with 3.4.16) to sanitize question prompts. The checklist and notes below describe the patch as it was built and checked against its baseline.

**`tests/viewer.mjs` is archived with the patch.** It is the browser check of the patched viewer: it targets that viewer's prompt, API calls and UI, so it fails against current upstream ADAPT, whose own `DiscussItViewer.vue` is a different component. That failure is expected. It is kept for reference only, is not maintained, and is not a validation step.

## Archived patch checklist (reference)

1. Keep LT's existing authentication, role, enrollment, section/group and assignment-availability rules. Review the adapter calls into ADAPT's User, Assignment, Submission and grading models.
2. Copy `resources/js/media/recording/`, `resources/js/components/recording/`, `resources/vendor/discuss-it/`, and the build-assets script into the host; merge the pinned MediaPipe dependency, `dompurify` for the patched viewer, and the asset-build command into its package setup. Do not replace its package manifest/lock wholesale.
3. The patch was checked with `git apply --check` against its baseline only; against current `master` it fails (see above), so port hunks by hand. The patch excludes copied recorder files, package locks, infrastructure, demo accounts/seeding and unrelated course-drag fixes.
4. Review the three feature tables/migration and backup policy. The migration deliberately refuses destructive rollback; retaining submitted media and grades is required. Use a disposable test database first.
5. Review feature API authentication/throttling, the feature-scoped streaming PUT size allowance, private storage configuration and signed playback authorization/range behavior. Do not expose the storage backend directly.
6. Provide FFmpeg/ffprobe in the host's existing deployment, verify processor binary paths, and schedule `php artisan discuss-it:process-media` with single-run/concurrency control. This handoff intentionally contains no provider-specific, container, or service-manager configuration.
7. Build the host UI and serve model/worker/WASM/module assets with correct MIME types from `/assets/discuss-it/`, or from another same-origin directory passed to the recorder as `assetBase`. (Written for the patch's baseline. Since v0.1.7, `assetBase` may also be on the host's own asset CDN, as described above.) Test normal View Assessments as well as the direct discussion route. The mobile layout hunks stack the Discuss-It assessment column and remove redundant gutters; they must be reconciled with LT's own responsive layout.
8. Run the provided isolated backend/media checks against the integrated app. Inspect each test's setup before running; use a disposable container with SQLite `:memory:` and no production environment. The recorder tests in the repo root do not require ADAPT.
9. Verify on real Android Chrome and iPhone Chrome/Safari: permissions, front/rear, mirror, blur, custom photo, interruptions, review, submit, playback and captions. Verify instructor/student roles, groups, deadlines, moderation and grades independently.

The patch's automatic completion grading is optional; leave it disabled unless explicitly approved. Grouping uses course sections. Editing graded responses is restricted. The discussion list currently caps at 500 comments. Native media upload and manual text/captions remain available. Uploads are a single PUT, so an interrupted upload starts again from the beginning; the client gives up only after 60 seconds without upload progress (with axios 0.21 or 1.x). Leaving the question mid-upload still finalizes a completed upload, and an upload that started within its two-hour window can be finalized after it. Only media problems (failed checks, or input ffprobe cannot read) are logged at notice level and blamed on the student's clip; other processing failures, including encoder errors and timeouts, are logged as errors and reported as server problems. Other ADAPT question types still render author prompts without sanitizing; the patch sanitizes only the Discuss-It prompt. This is implementation material to review, not a claim of production acceptance on a different ADAPT version.
