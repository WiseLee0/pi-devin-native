# Security

## Status and scope

This is an unofficial pre-release provider with no validated live end-to-end Devin session yet. The tested compatibility baseline is Pi 1.0.4 and Node.js >=22.19.0; no long-term security support or response-time commitment is established.

Pi executes tools locally. Prompts, selected file contents, tool results, and supported images can be sent to the backend. Only use the extension in environments and accounts where that access is authorized. Server-provided zero rates do not guarantee free use.

## Protect credentials and data

- Prefer `/login devin`. Treat Pi's `~/.pi/agent/auth.json` and native CLI session tokens as secrets. Do not copy them into the repository or attach them to reports.
- `DEVIN_API_KEY` accepts a CLI session token, not a guaranteed-compatible cloud task API key. Inject it securely; avoid shell history, command-line arguments, screenshots, and shared environment dumps.
- Do not share callback URLs containing authorization codes/state, JWTs, private prompts, or raw network captures.
- The login listener binds to `127.0.0.1:59653` temporarily and uses PKCE/state validation. Do not expose it broadly; use a trusted tunnel if remote login requires forwarding.
- Known tokens/JWTs are redacted from errors, and authentication fields are withheld from the ordinary payload hook before sending. This is defense in depth, **not a promise that all logs, response/native-stream hooks, or third-party extensions are secret-free**. Review and sanitize diagnostics yourself.
- `/logout devin` removes Pi's stored authorization; it should not be assumed to revoke an already exposed server-side token. If a secret leaks, remove public exposure and use the provider's available account/session revocation controls, then reauthenticate. Rewriting Git history alone is insufficient.

## Reporting a vulnerability

**No private reporting address or channel has been configured in this checkout.** Before public release, maintainers must fill in the real repository metadata and provide an actual security contact route.

If the eventual GitHub repository enables private vulnerability reporting, use **Security → Report a vulnerability** to open a private advisory. Do not assume this feature is enabled. If it is unavailable, wait for a verified private maintainer channel or ask for one using a non-sensitive public message. **Never post secrets, exploit-bearing sensitive captures, or private account data in public issues.**

A sanitized private report should describe affected versions, impact, reproduction steps using fake credentials where possible, and suggested mitigations. Do not send a real token to demonstrate a bug.
