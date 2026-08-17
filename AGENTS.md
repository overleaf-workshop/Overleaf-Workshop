# Overleaf Workshop Local Fork

## Local Replica Sync

- Runtime local changes are event-driven through VS Code `FileSystemWatcher`; do not add periodic directory or hash polling.
- `.overleaf/sync-state.json` stores the remote history version and SHA-256 content baseline used only for startup/reconnect reconciliation.
- `.overleaf/settings.json` is the authoritative local-replica association. It must contain enough project URI and SCM settings metadata to rebuild the transient per-login project/SCM state after authentication expires.
- Batch startup state changes into one write and skip writes when serialized state is unchanged; do not rewrite the state file once per synchronized path. The file is a disposable cache, so write it in place to avoid delete/create watcher events.
- History API failures such as HTTP 429 must not be interpreted as a missing version. Leave the checkpoint unchanged and retry on a later reconnect.
- Reuse recent history updates for both version discovery and changed-path collection. Serialize unavoidable history requests and honor `Retry-After` instead of issuing immediate parallel probes.
- Route every HTTP request from every project through one process-wide queue. A 429 response pauses the entire queue for `Retry-After`; local watcher bursts are debounced before upload.
- A failed path must make incremental startup sync fail explicitly; never log completion or advance `remoteVersion` after partial failure.
- Report final user-actionable failures through a deduplicated VS Code notification with access to the Output log; individual retries remain log-only.
- Connection and SCM creation logs must include project ID, connection scheme, retry attempt, local base URI, and the original structured error. Never swallow `joinProject` or trigger-initialization errors behind a generic reconnecting message.
- Disposing a cached VFS is terminal: disconnect handlers must not schedule reconnects after disposal. Successful `Open Project Locally` creation must leave its provider-owned VFS alive.
- Ignore every path containing a dot-prefixed component, including `.output`, before any stat/read/write work.
- Ignore symbolic links and paths below symbolic-link directories in both directions. Never upload them, overwrite/delete them during a pull, or include them in sync state.
- Never choose a winner or synthesize a merge when both sides changed. Pause that path, preserve both sides, notify the user, and require manual resolution followed by a window reload. Do not create conflict-copy files.
- Full remote-to-local sync is automatic only for an empty replica or when all local hashes still match the checkpoint. Missing/invalid history plus uncheckpointed local changes pauses all replica watchers.

## Verification

- Run `npm run compile`, `npm run lint`, and `git diff --check` after synchronization changes.
- Package local builds with `npx @vscode/vsce package --out overleaf-workshop-local-0.15.10.vsix` and install with `code --install-extension <vsix> --force`.
