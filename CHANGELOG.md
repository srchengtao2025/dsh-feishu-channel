# Changelog

All notable changes to this project are documented here.

## 0.8.1 - 2026-08-17

- Added secure inbound Feishu file and image handling.
- Added pending-file association with the next Harness task.
- Added the `feishu_send_file` agent tool and `/file` commands for outbound files.
- Added file-transfer settings, size limits, filename sanitization, and workspace boundary checks.
- Added Feishu `im:resource` permission status reporting.
- Added native CardKit streaming with automatic text-edit fallback.
- Added CLI model configuration, one-time approvals, and short-lived Web UI links.

## Compatibility

- DeepSeek Harness: `0.1.0-rc.5`
- Node.js: 22 or later
