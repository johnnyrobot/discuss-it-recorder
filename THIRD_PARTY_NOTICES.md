# Third-party notices

The extraction preserves the ADAPT source tree's MIT license notice in `LICENSE` (Copyright 2017 Cretu Eusebiu). No claim of ownership of upstream ADAPT or Google assets is made.

Google MediaPipe Tasks Vision 0.10.35 and the Selfie Segmenter model are Apache-2.0. The model notice/license is retained under `resources/vendor/discuss-it/`. Runtime package notices remain in the installed npm package; when deploying copied runtime assets, include the Apache license staged by the build script and preserve any runtime notices. Model source URL and SHA-256 are documented alongside the model. Builds verify the checked-in model and do not fetch an unpinned model.

Vue 2 (MIT) is a development/demo dependency and optional adapter target, not required by the recorder core; the hosted demo serves Vue's browser build with its MIT notice, and the MediaPipe Apache license with the runtime assets. Playwright (Apache-2.0) is test tooling. The optional ADAPT backend invokes FFmpeg; obtain an appropriately licensed build for your deployment and preserve its notices. This repository does not redistribute FFmpeg binaries. The optional ADAPT viewer imports DOMPurify (MPL-2.0 or Apache-2.0), which the host installs; it is not redistributed here.
