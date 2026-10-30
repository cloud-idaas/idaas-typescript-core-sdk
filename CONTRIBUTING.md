# Contributing

Use Node.js 24 for development and run commands from this repository root. The package's consumer compatibility is documented in [README.md](README.md).

## Development

```sh
npm ci --ignore-scripts
npm run verify
npm run build
```

Use `npm run format` to apply formatting. Check Markdown formatting and links for documentation-only changes; run relevant checks and tests for code changes. Core certificate tests also require OpenSSL.

## Pull requests

Explain the problem, user-visible behavior, compatibility impact, and validation performed. Use conventional commits such as `fix(http): improve request identification`. Follow [CODING_STANDARDS.md](CODING_STANDARDS.md), update both READMEs when usage changes, and keep [CHANGELOG.md](CHANGELOG.md) focused on release-relevant changes. Never include real credentials or customer configuration.

## Releases

See [RELEASE.md](RELEASE.md). A matching version tag starts automatic verification and publication; create or push release tags only when a release is intended.
