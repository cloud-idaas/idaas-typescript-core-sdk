# Coding Standards

These conventions apply to this repository and can be followed using its source and public documentation.

## Compatibility and API design

- Use TypeScript for SDK code. Preserve the documented Node.js and TypeScript consumer compatibility.
- Keep CommonJS and ESM public exports consistent. Consumers use the package entry point rather than private file paths.
- Document public parameters, return values, errors, time units, and resource lifetimes. Describe observable behavior without development notes or implementation walkthroughs.
- Treat public API and configuration changes as compatibility changes and record them in CHANGELOG.md.

## Code quality

- Use the repository's formatter, lint rules, strict type checks, and locked dependencies.
- Prefer descriptive names, small interfaces, and explicit ownership of injected resources.
- Validate external input at runtime; use unknown until data has been checked. Do not use unchecked assertions to hide invalid data.
- Use asynchronous interfaces for I/O. Avoid network activity during module import or construction.
- Keep shutdown idempotent and errors actionable. Do not swallow errors or extend a credential's lifetime beyond its actual expiration.

## Security and testing

- Never commit or log actual credentials, private keys, tokens, customer data, or private endpoints. Examples use placeholders.
- Keep TLS verification enabled by default and use maintained cryptographic libraries.
- Test public behavior, including failures and lifecycle boundaries. Tests must not require live customer credentials.
- Validate package entry points and declarations when changing public types or supported runtimes. Record live service testing separately from local tests.

## Documentation

Use English for SDK comments, examples, release notes, and development guides. Maintain an English README.md and a matching Chinese README_zh.md; code examples remain English in both. README files describe installation, configuration, supported APIs, and usage. Changelogs describe user-visible additions, fixes, and migrations rather than review sessions or test execution records.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development commands.
