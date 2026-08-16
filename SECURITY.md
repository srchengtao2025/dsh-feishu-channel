# Security Policy

## Supported version

Security fixes are applied to the latest published release.

## Reporting a vulnerability

Do not open a public issue containing credentials, tokens, tenant identifiers, user identifiers, private message content, or exploitable details. Use GitHub's private vulnerability reporting feature on this repository when available.

Include the affected version, impact, reproduction conditions, and a minimal redacted example. Never send a real App Secret or model API key.

## Deployment guidance

- Keep the Harness Web service bound to `127.0.0.1` and use an SSH tunnel for configuration.
- Configure an explicit Feishu `open_id` allowlist before production use.
- Treat temporary Web UI URLs as bearer credentials.
- Review every privileged approval request before allowing it.
- Keep file transfer size limits enabled and do not execute uploaded files unless explicitly intended.
