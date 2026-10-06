# Contributing

This is an unofficial, unpublished pre-release integration. Offline tests do not establish live Devin compatibility. Please keep that distinction explicit in changes and reports.

## Local setup

Use Node.js >=22.19.0. The compatibility baseline is Pi 1.0.4 (`@earendil-works` APIs).

```bash
npm ci
npm run check
npm run release:check
```

Use the committed lockfile and local development dependencies. Do not link packages from a global Pi installation, use machine-specific paths, or require a pre-existing developer `node_modules` directory. The runtime extension receives its peer APIs from Pi; development and CLI tests resolve their dependencies locally.

`check` runs type checking and the offline test suite. The Pi CLI integration uses mocked service responses, a temporary configuration directory, and a temporary file for its read-tool cycle. It must not read the user's `auth.json` or contact real Devin services. If publication metadata is still unresolved, `release:check` is expected to reject release readiness; do not bypass it or fill fields with invented identities.

## Changes and reports

- Keep changes focused; add regression tests for protocol, authentication, discovery, and streaming behavior.
- Test cancellation, malformed/truncated input, and credential redaction when changing network code.
- Never commit session tokens, JWTs, callback authorization codes, `auth.json`, private prompts, or unsanitized captures. Use fake credentials in fixtures.
- Keep English and Chinese READMEs aligned, especially permissions, billing, compatibility, and live-validation caveats.
- Record user-visible changes in `CHANGELOG.md`; preserve `LICENSE` and maintain attribution for upstream adaptations in the READMEs.
- Include the Node/Pi versions, command, sanitized error, and whether a report used mocks or the live service. Do not label mock success as live validation.

Once an actual GitHub repository is configured, use its issues and pull requests for non-sensitive changes. No repository or private contact channel is asserted by this checkout. For vulnerabilities, follow [SECURITY.md](SECURITY.md), not a public issue containing secrets.

## Optional live testing

Live testing is manual and requires an authorized Devin account with CLI/Terminal and model access. It can incur charges and sends prompts/file contents to the service. It is not part of `npm ci` or the default checks. Use an isolated Pi configuration and non-sensitive temporary files; keep real credentials out of test artifacts. Follow the live smoke checklist in [RELEASE.md](RELEASE.md).

Do not publish or upload packages merely to test a change. Publication requires the maintainer's release gates and explicit authorization.
