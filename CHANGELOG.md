# Changelog

## Unreleased — 0.1.0 pre-release preparation

No public GitHub/npm release is asserted. The package remains private pending release readiness and live validation.

### Added

- Native Devin CLI OAuth with PKCE/state and a temporary loopback callback.
- Account-specific model discovery, native model UIDs, optional server routing, and Connect/Protobuf streaming adapted for Pi.
- Text, thinking/signatures, local Pi tool-call/result round trips, and capability-based image handling.
- Cancellation, request timeouts, frame/tool-argument limits, malformed-stream detection, and credential-related safeguards.
- Offline regression coverage and a mock backend tool cycle through the real Pi CLI.
- English/Chinese usage documentation, contribution and security guidance, and a gated release checklist.
- Reproducible pinned development dependencies, CI configuration, and package-content/credential checks.
- A packed-artifact smoke test that loads the extension without checkout dependencies.

### Fixed

- Removed reliance on Pi AI subpath imports that fail through Pi's host alias when loading a dependency-free packed extension.

### Compatibility and limitations

- Compatibility baseline: Pi 1.0.4 (`@earendil-works` APIs), Node.js >=22.19.0.
- A Devin account with CLI/Terminal and selected-model permissions is required.
- Live OAuth, discovery, chat, and tool-result round trips with a real subscription remain unvalidated.
- No cloud Devin task execution, Native Fusion orchestration, strict tool grammar, or subscription-balance reporting.
- Zero displayed prices are not a guarantee of free use; packaging checks are not live service validation.

Upstream attribution is recorded in the READMEs; retain the copyright notices and license text in `LICENSE` when redistributing.
