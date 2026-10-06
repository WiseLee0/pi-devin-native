# Pre-release and publication checklist

## Current state

The checkout is an **unpublished, unofficial pre-release**. Keep `private: true` for now. It prevents accidental npm publication; it does not prevent local `pi install`, tests, or package inspection. Offline/mock success and `npm pack --dry-run` **do not prove live OAuth, model access, chat, billing, or tool-result round trips work**.

Do not upload or publish as part of routine development. Publication is a separate, explicitly authorized maintainer action.

## 1. Make a clean checkout reproducible

Use Node.js >=22.19.0 and the tested Pi 1.0.4 API/CLI baseline:

```bash
npm ci
npm run check
```

The lockfile and local development dependencies must be sufficient, including the CLI used by integration tests. No global installation path, package symlink, developer credentials, or pre-existing `node_modules` directory may be required. Default tests must remain offline, isolated from real Pi credentials, and use mocked backend responses.

## 2. Resolve publication identity and contact routes

While `private: true` is still set, fill `package.json` with truthful, non-placeholder values:

- `author`: the actual responsible author/maintainer; do not invent a person or email.
- `repository`: the real repository URL and type.
- `homepage`: the real project/documentation location.
- `bugs`: the real issue tracker or verified contact route for non-sensitive reports.
- `name`: the actual available npm name/scope controlled by the publisher.

Update the lockfile consistently with the final name and dependency changes. Add public installation instructions only for confirmed locations; keep the unpublished notice until the corresponding artifacts actually exist. Configure and document a verified private security channel, using GitHub private vulnerability reporting only if enabled. Public issues are not a place for credentials.

Review `files` and package contents so runtime source, English/Chinese documentation with upstream attribution, and `LICENSE` are included as intended. Exclude credentials, local Pi configuration, caches, debug dumps, and unnecessary test/development artifacts.

## 3. Perform an authorized live smoke test

Do this manually before switching off `private`. Use an entitled Devin account, an isolated Pi configuration, and non-sensitive temporary data. A real subscription may be billed; zero displayed rates do not guarantee free use.

- Load/install the extension once under Pi 1.0.4.
- Complete `/login devin` with the native Devin account and loopback callback; confirm listener cleanup.
- Run `/devin-refresh`; verify actual permitted models rather than relying on the `swe-1-6` boot seed.
- Select an allowed model and receive a minimal text reply.
- Have Pi read a harmless temporary file; confirm tool invocation, local execution, and the next-turn tool-result response.
- If routing/image capabilities are claimed for this release, test those separately with permitted models; do not generalize one model's success to all models/accounts.
- Check cancellation and sanitized errors without recording secrets. Run `/logout devin` and remove isolated credentials/artifacts.

Record Node/Pi versions, date, tested model UIDs, and sanitized outcomes in the release notes. Do not store tokens, authorization callback URLs, account identifiers, private prompts, or raw traces. If live access is unavailable or fails, keep the package private and clearly state that live validation is outstanding.

## 4. Run release gates and inspect the artifact

```bash
npm run release:check
npm pack --dry-run
```

While `private: true` remains set, `release:check` intentionally fails the publication gate; `npm run check` and artifact inspection can pass independently. Do not remove the private flag just to make this preliminary step green.

`release:check` includes the normal checks, publication metadata validation, credential/leak checks, and package-content validation. Missing identity fields, placeholder repository/scope values, or suspicious secret material must block readiness. **`prepublishOnly` must execute `npm run release:check`** so npm publication repeats these gates. Do not use `--ignore-scripts` or disable checks to get past a failure.

A static credential scan cannot prove that an artifact is secret-free; manually inspect the file list and distribution contents as well. Check that the original copyright notices and license text in `LICENSE`, and upstream attribution in the READMEs, are preserved. A successful pack/dry-run only validates packaging, never live usability.

## 5. Authorize and publish a pre-release

Only after truthful metadata is complete, the live smoke test has passed, and the normal tests/package-content checks are satisfied, perform the final publication gates:

1. Set `private: false` deliberately. Retain the public npm registry (`https://registry.npmjs.org/`) for an npm public release, not a developer/local/private registry. Reconcile any `publishConfig` with that decision.
2. Set the intended version, update the lockfile/changelog, and repeat `npm ci`, `npm run check`, and `npm run release:check` on the final tree.
3. Confirm the logged-in npm publisher controls the actual scope/name, supports required authentication/2FA, and has explicit approval to publish. Do not expose npm credentials in logs.
4. Publish with the pre-release distribution tag:

   ```bash
   npm publish --access public --tag next
   ```

The npm dist-tag `next` is separate from a Git release tag such as `v0.1.0`; neither establishes the other. Do not let an experimental publication become npm's `latest` implicitly. Choose Git tags and release notes to match the actual version and pre-release status. Stable publication or promotion to `latest` requires a separate review; it is not part of this checklist.

After publication, confirm the real GitHub/npm locations and installation instructions from the published artifact, and report exactly which live paths were tested. Never claim support for untested accounts, models, or protocol changes.
