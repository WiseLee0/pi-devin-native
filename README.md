# pi-devin-native

[简体中文](README.zh-CN.md)

A Devin native CLI model provider for Pi. Sign in with a Devin account. Models respond through the Devin CLI backend, while file reads, edits, and commands run through local Pi tools.

This is an unofficial extension, not the Devin cloud task API. It does not create remote Devin Agent tasks.

## Requirements

- Node.js >=22.19.0.
- Pi; development and tests use the `@earendil-works` 1.0.4 APIs. Older `@mariozechner` APIs are not guaranteed to work.
- A Devin account with CLI/Terminal access and permission to use the selected model.

## Installation

After downloading this project, run from its directory:

```bash
pi install .
```

Restart Pi to load the extension. For temporary use, run from this project's directory:

```bash
./start.sh
```

The script runs `pi -e` with the absolute path to `index.ts` and forwards Pi command-line arguments. To load it from another working directory, use an absolute path:

```bash
pi -e /absolute/path/to/pi-devin-native/index.ts
```

Choose either installation or temporary loading, not both, to avoid registering `devin` twice. The package currently has `private: true`; only local installation is documented here.

## Usage

In Pi:

```text
/login devin
/devin-refresh
/model
```

1. Follow the login instructions to authorize your Devin account in a browser.
2. Run `/devin-refresh` to discover the CLI models available to your account.
3. Select a model under the `devin` provider using `/model`, then use Pi normally.

Login uses `http://127.0.0.1:59653/callback` with a five-minute timeout. If Pi runs on a remote machine, arrange callback port forwarding yourself. Pi manages credentials; log in again when they expire. Sign out with `/logout devin`.

Successful refreshes persist model metadata, never credentials, in Pi's `<agent-dir>/models-store.json` (normally `~/.pi/agent/models-store.json`). Fresh processes restore this catalog before selecting the startup model, so a Devin default saved with `Ctrl+S` in `/model` survives restarts, including offline startup. Failed refreshes retain the last successful catalog.

Only installations without a cached catalog use the initial `swe-1-6` boot seed, which is not proof of account access. Run `/devin-refresh` once before selecting your first default model; the refreshed catalog remains authoritative.

### Existing credentials

`DEVIN_API_KEY` accepts a native CLI session token, optionally prefixed with `devin-session-token$`. **A Devin cloud task API key is not a substitute.** Prefer browser login, and never put credentials in committed files, chats, or logs.

## Supported behavior

- Devin OAuth login, account-specific model discovery, and Connect/Protobuf streaming.
- Text, thinking/signatures, tool calls, and tool-result round trips.
- Images according to declared server capabilities; SWE-1.6 models are treated as text-only.
- Native model UIDs and effort variants remain separate. Change reasoning effort by selecting the corresponding model, not through Pi's thinking-level controls.
- Cancellation, timeouts, and malformed-stream checks.

Native Fusion orchestration, strict tool grammar constraints, and subscription-balance reporting are not supported. Cost metadata comes from the server; **a displayed zero does not mean free use**.

The project includes offline tests and Pi CLI integration tests with a mocked backend. These do not establish end-to-end compatibility with a real Devin subscription. Backend protocol or login changes may break the extension.

## Troubleshooting

| Problem | Action |
| --- | --- |
| Login port is occupied | Free port 59653 and retry. |
| Browser authorization does not return | Check loopback access, proxies, or remote port forwarding. |
| 401 | Log in again and confirm you are using CLI credentials. |
| 403 or discovery failure | Verify CLI/model permissions, then run `/devin-refresh`. |
| 429 | Check quota and retry later. |

Remove credentials and private content before reporting problems. See [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci
npm run check
```

`check` runs TypeScript checks, offline tests, and package checks. See [RELEASE.md](RELEASE.md) for publication and [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.
