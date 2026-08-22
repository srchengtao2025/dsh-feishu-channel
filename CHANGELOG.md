# Changelog

All notable changes to this project are documented here.

## 0.10.1 - 2026-08-21

- Fixed the optional knowledge-search result limit schema for DeepSeek Harness runtime tool validation.

## 0.10.0 - 2026-08-21

- Added configurable read-only Feishu/Lark Wiki RAG with local persisted indexing, periodic refresh, source links, and partial-access fallback.
- Added scoped `feishu_kb_search` and `feishu_kb_read` Agent tools that remain available in the minimal Agent Preset.
- Added Web and CLI configuration fields plus knowledge-index health reporting.

## 0.9.4 - 2026-08-21

- Isolated deterministic Feishu session ids by Agent Preset so switching between standard and minimal modes cannot replay incompatible tool history.

## 0.9.3 - 2026-08-21

- Fixed `/webui` startup on standard Linux packages by discovering `cloudflared` from `PATH`, with optional `DSH_CLOUDFLARED_PATH` override.
- Normalized proxied Origin and Referer headers so DSH HTTP and WebSocket same-origin checks accept temporary Web UI requests.
- Matched the temporary access cookie lifetime to the requested tunnel TTL and preserved upstream cookies.

## 0.9.2 - 2026-08-21

- Fixed `allow add` and `allow remove` disabling an already-enabled channel when saving the updated allowlist.

## 0.9.1 - 2026-08-21

- Added explicit Feishu domestic and Lark international API-domain selection across Web, CLI, credential tests, REST clients, CardKit, and long connections.
- Kept Feishu domestic as the backwards-compatible default.

## 0.9.0 - 2026-08-21

- Updated and live-tested the plugin against DeepSeek Harness `0.1.0-rc.8`.
- Added an explicit streaming output switch to the Web configuration page and CLI.
- Added `--streaming` and `--no-streaming` CLI options.
- When streaming is disabled, the channel sends an optional acknowledgement followed by one final text reply.
- Fixed CLI partial updates unexpectedly disabling an already-enabled channel.
- Fixed the Web configuration page failing to load because allowlist newlines were not escaped in the generated inline script.
- Documented the explicit `protobufjs: false` build-policy entry required by pnpm 11 strict dependency-build checks.

## 0.8.1 - 2026-08-17

- Added secure inbound Feishu file and image handling.
- Added pending-file association with the next Harness task.
- Added the `feishu_send_file` agent tool and `/file` commands for outbound files.
- Added file-transfer settings, size limits, filename sanitization, and workspace boundary checks.
- Added Feishu `im:resource` permission status reporting.
- Added native CardKit streaming with automatic text-edit fallback.
- Added CLI model configuration, one-time approvals, and short-lived Web UI links.

## Compatibility

- DeepSeek Harness: `0.1.0-rc.8`
- Node.js: 22 or later
