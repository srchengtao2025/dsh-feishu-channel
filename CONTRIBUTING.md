# Contributing

Thanks for improving `dsh-feishu-channel`.

## Development setup

```bash
npm ci
npm test
npm run check
npm run pack:check
```

The package intentionally keeps all DeepSeek Harness dependencies as optional peers. Run integration tests against the Harness version listed in `CHANGELOG.md`.

## Pull requests

- Keep credentials, tenant identifiers, user identifiers, message payloads, private server addresses, and production logs out of commits and tests.
- Add focused tests for behavior changes and security boundaries.
- Preserve loopback-only configuration access, explicit enable confirmation, allowlist behavior, and workspace file confinement.
- Update `README.md`, `README.en.md`, and `CHANGELOG.md` when user-facing behavior changes.
- Use a concise title and explain compatibility or migration impact.

## Release checklist

1. Update the package version and changelog.
2. Run all validation commands above.
3. Inspect `npm pack --dry-run` and scan the repository for secrets.
4. Create a signed or annotated `vX.Y.Z` tag.
5. Attach the generated `.tgz` file to the GitHub Release.
