# No telemetry: MediaPipe Tasks Vision stays on 0.10.x

Accepted 2026-10-25.

Learner video and its processing stay on the device, and the recorder reports nothing anywhere: no analytics, telemetry or usage metrics. A recording leaves the browser only when the host uploads it or the user downloads it. MediaPipe Tasks Vision 1.x breaks this. By default it POSTs usage metrics to Google (`https://odml.pa.googleapis.com/v1/log`, with an API key in an `x-goog-api-key` header), and 1.1.1's README and type definitions offer no way to turn that off. So the recorder stays on 0.10.x, pinned exactly at 0.10.35, and adopts no release or option that reports usage or otherwise phones home. The segmentation model, worker and WASM stay self-hosted: the host serves them from its own origin (`assetBase`), and nothing is fetched from Google or a CDN at runtime.

## Considered options

- **Move to 1.x.** It keeps the APIs the recorder uses (checked with 1.1.1). Rejected: MediaPipe says the metrics cover performance and usage, not camera frames, but any outside network traffic breaks the privacy promise, and MediaPipe's README makes the app responsible for getting users' consent to it.
- **Use 1.x and block the logging**, by patching the vendor bundle or with a Content-Security-Policy. Rejected: a patched bundle has to be redone and checked again on every update, and a CSP belongs to the host, so the recorder could not promise it.

## Consequences

- 0.10.x will stop getting fixes at some point. When it does, revisit this decision rather than work around it. A 0.10.x update is a deliberate change: pin the exact version, run `npm run build`, and the checks below must pass.
- `npm test` runs `tests/discuss-it/no-telemetry.mjs`. It fails unless `package.json` and the lock file pin the same exact 0.10.x release, the staged assets come from that release, and no staged asset or recorder source names a Google API host (other than `type.googleapis.com`, which only prefixes protobuf type names), Google's API key header, or a known analytics or logging endpoint.
- The recorder browser test aborts any request to another origin, from the page or its worker, and fails if there was one.
