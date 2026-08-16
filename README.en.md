# DSH Feishu Channel

[![CI](https://github.com/srchengtao2025/dsh-feishu-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/srchengtao2025/dsh-feishu-channel/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/srchengtao2025/dsh-feishu-channel)](https://github.com/srchengtao2025/dsh-feishu-channel/releases)
[![License](https://img.shields.io/github/license/srchengtao2025/dsh-feishu-channel)](./LICENSE)

[中文说明](./README.md) · [Changelog](./CHANGELOG.md) · [Security](./SECURITY.md)

`dsh-feishu-channel` is a community-maintained plugin that connects a DeepSeek Harness instance to a Feishu/Lark custom enterprise app over a WebSocket long connection. The Harness server can remain bound to loopback and does not need a new public inbound port.

> Status: Developer Preview. Version 0.8.1 is developed and tested against DeepSeek Harness `0.1.0-rc.5`. Re-run the test suite after upgrading Harness.

## Features

- Web and CLI configuration with credentials stored through the Harness credential service.
- Private-chat access and optional group `@bot` handling with an `open_id` allowlist.
- Persistent Harness sessions mapped to Feishu conversations.
- Streaming replies using native CardKit when available, with automatic text-edit fallback.
- Bidirectional workspace-scoped file transfer, including a `feishu_send_file` agent tool.
- One-time approval cards for privileged Harness operations.
- Short-lived Web UI URLs for explicitly allowlisted users.
- Message deduplication, per-chat serialization, filename sanitization, size limits, and workspace boundary checks.

## Requirements

- DeepSeek Harness `0.1.0-rc.5`
- Node.js 22 or later
- A Feishu custom enterprise app with bot capability enabled

## Install

Download the latest `dsh-feishu-channel-*.tgz` from GitHub Releases and install it into the Harness Web profile:

```bash
dsh plugin --profile web add ./dsh-feishu-channel-0.8.1.tgz
```

To build from source:

```bash
git clone https://github.com/srchengtao2025/dsh-feishu-channel.git
cd dsh-feishu-channel
npm ci
npm test
npm pack
dsh plugin --profile web add ./dsh-feishu-channel-0.8.1.tgz
```

Restart Harness, keep it bound to loopback, and open the configuration page through an SSH tunnel:

```bash
ssh -N -L 3080:127.0.0.1:3080 user@YOUR_SERVER
```

Open `http://127.0.0.1:3080/feishu-channel`.

## Feishu app setup

Enable these app permissions:

- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`
- `im:resource`
- `cardkit:card:write` for native streaming cards (recommended)
- `im:message.group_at_msg:readonly` when group mentions are enabled

Select long-connection event delivery, add `im.message.receive_v1`, and add `card.action.trigger` if approval buttons are required. Publish an app version and include the intended users in the app availability scope.

## Configure

Run the interactive CLI on the Harness server:

```bash
dsh-feishu-config show
dsh-feishu-config configure
```

The setup flow saves configuration while keeping the channel disabled, then explicitly asks whether it should validate credentials and enable the channel. Secrets are entered without echo and are not returned by the configuration API.

When the allowlist is empty, private chats are allowed by default while group chats remain denied. For production use, send `/whoami`, add the returned `open_id` to the allowlist, and avoid leaving private access open.

## File transfer

Send a file in a private Feishu conversation, wait for the receipt acknowledgement, then send the instruction that should use the file. Received files are stored under `.dsh-feishu/inbox` inside the configured workspace and are never executed automatically.

Use these commands for manual outbound transfer:

```text
/file list
/file send output/report.md
/file help
```

Outbound paths are resolved with `realpath` and must remain inside the Harness workspace. Empty files, oversized files, traversal paths, and symlinks escaping the workspace are rejected.

## Development

```bash
npm ci
npm test
npm run check
npm run pack:check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## License

MIT. This is not an official DeepSeek project.
