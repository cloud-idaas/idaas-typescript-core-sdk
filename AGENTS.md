# AGENTS.md

## Repository scope

Provides IDaaS authentication, OAuth token exchange, credential providers, and configuration.

This directory is an independent Git repository. Run development commands from this repository root and preserve unrelated work.

- `src/`: SDK source and public exports.
- `test/`: automated tests.
- `examples/`: CommonJS, ESM, and TypeScript usage examples.
- `scripts/`: build, dependency setup, and package validation tools.
- `.github/workflows/`: CI and release workflows.

## Public references

- [README.md](README.md) and [README_zh.md](README_zh.md): supported APIs, configuration, compatibility, and usage.
- [CODING_STANDARDS.md](CODING_STANDARDS.md): coding, security, testing, and documentation conventions.
- [CONTRIBUTING.md](CONTRIBUTING.md): contribution and development setup.
- [CHANGELOG.md](CHANGELOG.md): user-visible changes and migrations.
- [RELEASE.md](RELEASE.md): release prerequisites and publication setup.

## Development setup

Use Node.js 24 for development. Preserve support for Node.js 20, 22, and 24 and TypeScript 4.7 or later for consumers. CI uses npm 11.21.1; use the same version when reproducing CI or updating the lockfile.

```sh
npm ci --ignore-scripts
npm run verify
npm run build
```

Core certificate tests also require OpenSSL on PATH.

## Build and test commands

- `npm run check:language`: check that developer-facing text is English, with Chinese prose allowed in README_zh.md.
- `npm run typecheck`: check source and test types.
- `npm run lint`: run the configured ESLint rules.
- `npm run format:check`: check formatting; `npm run format` applies it.
- `npm test`: build and run the Mocha test suite with coverage collection.
- `npm run verify`: run language, type, lint, formatting, and test checks.
- `npm run build`: produce CommonJS and ESM entry points and their declarations.
- `npm pack`: build and create a local package archive for inspection.

For documentation-only changes, check Markdown formatting, relative links, and command accuracy. For code changes, run relevant tests and `npm run verify`. When changing public exports, declarations, or runtime compatibility, validate packaged CommonJS, ESM, and TypeScript consumer examples. Report local checks and live service tests separately.

## Development conventions

- Follow [CODING_STANDARDS.md](CODING_STANDARDS.md) and the checked-in formatter, lint, and TypeScript configurations.
- Keep CommonJS and ESM public APIs consistent and preserve documented consumer compatibility.
- Validate external input at runtime, keep errors actionable, and document parameters, return values, time units, and resource ownership.
- Keep resource shutdown idempotent, respect caller ownership, and never return expired credentials.
- Test observable behavior, failure cases, and lifecycle boundaries without real customer credentials.
- Keep TLS verification enabled by default. Never commit or log credentials, private keys, tokens, customer data, or private endpoints.
- Use English for comments, TSDoc, diagnostics, tests, examples, development guides, and commit messages. Keep English README.md and Chinese README_zh.md aligned, with English code examples in both.
- Update public API documentation and release-relevant changelog entries when behavior or compatibility changes. Keep implementation walkthroughs and execution records out of user-facing guides.
- Use conventional commits: `<type>(<scope>): <subject>`, such as `fix(http): improve request identification`.

## Release boundary

Read [RELEASE.md](RELEASE.md) before changing release behavior. Matching version-tag pushes trigger automatic verification and npm publication. Create or push version tags only when a package release is intended.
