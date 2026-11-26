# Changelog

## 0.1.0-beta.3

- Identify Core in generated User-Agent headers as `idaas-typescript-core-sdk/<version>`.
- Validate configuration against the selected credential source and allow external PCA assertions without a local private key.
- Support custom authentication plugins without an OpenAPI endpoint and calculate token expiry from the start of the plugin call.
- Accept per-request Token Exchange credentials and additional form fields, and return granted scope and token type.
- Expose the build version and include the SDK component and runtime in the default User-Agent. Discover the local hostname by default, with support for an alias or disabling hostname collection. Use the same diagnostic settings for JSON and programmatic configuration.
- Apply independent connection and read timeouts.
- Reject empty or invalid injected authentication material before sending requests.
- Keep known OAuth and PAM error codes and report the HTTP status for unknown codes. Omit upstream error descriptions from SDK exception messages.

## 0.1.0-beta.2

- Publish a maintenance prerelease with no API changes.

## 0.1.0-beta.1

- Support machine authentication, access tokens, Token Exchange, configuration loading, and credential providers.
- Provide configurable User-Agent identification for SDK requests.
- Improve credential expiry, refresh failure, and shutdown handling.
- Require complete PEM certificates and valid intermediate chains for PCA authentication.
- Improve Bearer response validation and authentication with credentials containing special characters.
- Provide CommonJS/ESM packages, TypeScript declarations, and English/Chinese usage documentation.
