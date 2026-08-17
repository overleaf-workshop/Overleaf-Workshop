# Overleaf Workshop Local Fork

## Local Replica Sync

- Runtime local changes are event-driven through VS Code `FileSystemWatcher`; do not add periodic directory or hash polling.
- `.overleaf/sync-state.json` stores the remote history version and SHA-256 content baseline used only for startup/reconnect reconciliation.
- Batch startup state changes into one write and skip writes when serialized state is unchanged; do not rewrite the state file once per synchronized path. The file is a disposable cache, so write it in place to avoid delete/create watcher events.
- History API failures such as HTTP 429 must not be interpreted as a missing version. Leave the checkpoint unchanged and retry on a later reconnect.
- Reuse recent history updates for both version discovery and changed-path collection. Serialize unavoidable history requests and honor `Retry-After` instead of issuing immediate parallel probes.
- A failed path must make incremental startup sync fail explicitly; never log completion or advance `remoteVersion` after partial failure.
- Report final user-actionable failures through a deduplicated VS Code notification with access to the Output log; individual retries remain log-only.
- Ignore symbolic links and paths below symbolic-link directories in both directions. Never upload them, overwrite/delete them during a pull, or include them in sync state.
- Preserve the existing conflict policy: when a common history base cannot be obtained, the remote side wins. Do not create conflict-copy files unless the user changes this policy.

## Verification

- Run `npm run compile`, `npm run lint`, and `git diff --check` after synchronization changes.
- Package local builds with `npx @vscode/vsce package --out overleaf-workshop-local-0.15.10.vsix` and install with `code --install-extension <vsix> --force`.
