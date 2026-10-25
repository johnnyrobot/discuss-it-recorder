# Security and privacy

Use GitHub's private vulnerability reporting for security issues. Please do not include student recordings, credentials, signed playback URLs, or other personal data in a public issue. General bugs that contain no sensitive data may use the public issue tracker.

The standalone recorder has no analytics, telemetry, authentication, upload endpoint, or persistent storage. Camera frames, microphone audio, segmentation masks, and selected background photos stay in the browser. A completed recording exists as an in-memory Blob until the host application explicitly uploads it or the user downloads it.

An integrating application is responsible for authentication, authorization, consent, server-side media validation, private storage, retention, captions, access-controlled playback, and appropriate security headers. Treat all browser-produced media and metadata as untrusted input. The archived ADAPT patch is unmaintained reference material for an older, non-public ADAPT baseline; do not deploy it.

Security fixes land on `main` and ship in the next tagged release (see the GitHub Releases page); earlier releases are not patched. This project intentionally retains a legacy Vue 2 demo adapter; production consumers should use a maintained UI framework around the framework-independent recorder core.
