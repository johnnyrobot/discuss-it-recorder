# Self-hosted background segmentation

Runtime: `@mediapipe/tasks-vision` 0.10.35, pinned in package-lock.json (Apache-2.0). Stay on 0.10.x for now: 1.x sends usage metrics to Google (`odml.pa.googleapis.com`) by default; see [validation](../../../docs/VALIDATION.md).
Model: Google MediaPipe Selfie Segmenter float16, person confidence mask.
Downloaded 2026-09-09 from https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
SHA256: `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`.

The checked-in model is immutable for this release; builds do not fetch `latest`.
Run `node scripts/build-discuss-it-assets.cjs` to assemble same-origin worker, WASM, and model assets.
The generated manifest records hashes. No student's frames are transmitted to Google.
MediaPipe project/license: https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE
