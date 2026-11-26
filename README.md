# IDaaS TypeScript Core SDK

[Simplified Chinese](README_zh.md) | English

Authenticate machine identities and obtain IDaaS access tokens in Node.js.

## Requirements and installation

Supports Node.js 20, 22, and 24, JavaScript CommonJS/ESM, and TypeScript 4.7 or later. This is a Node.js SDK, not a browser SDK. Check your registry for available beta versions; use a provided package archive when evaluating an unreleased version.

```sh
npm install @cloud-idaas/core-sdk
```

## Usage

Set the secret environment variable used below, and replace example identifiers, endpoints, and scope with your application settings. Save the following ESM example as `example.mjs` and run it with Node.js. CommonJS uses the same named exports through `require`; asynchronous calls belong inside an async function.

```javascript
import { IDaaSCredentialProviderFactory } from '@cloud-idaas/core-sdk';

await IDaaSCredentialProviderFactory.init({
  idaasInstanceId: 'instance-id',
  clientId: 'application-id',
  issuer: 'https://issuer.example.com',
  tokenEndpoint: 'https://issuer.example.com/api/v2/authorization-server-id/oauth2/token',
  scope: 'api.example.com|read:file',
  authnConfiguration: {
    authnMethod: 'CLIENT_SECRET_POST',
    clientSecretEnvVarName: 'IDAAS_CLIENT_SECRET',
  },
});
try {
  const provider = await IDaaSCredentialProviderFactory.getIDaaSCredentialProvider();
  const token = await provider.getAccessToken();
  // Pass token to a trusted resource client; never print credentials.
} finally {
  await IDaaSCredentialProviderFactory.close();
}
```

## Configuration

Provide `idaasInstanceId`, `clientId`, `issuer`, `tokenEndpoint`, `scope`, and `authnConfiguration`. Scope uses `audience|permission`; separate multiple entries with spaces and request only the permissions the application needs.

Configuration can be supplied as an object or JSON file. File selection is: an explicit `init(path)` argument, then `CLOUD_IDAAS_CONFIG_PATH`, then `~/.cloud_idaas/client-config.json`. Keep actual secrets in environment variables referenced by the configuration.

| Authentication                                                   | Required credential source                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `CLIENT_SECRET_BASIC`, `CLIENT_SECRET_POST`, `CLIENT_SECRET_JWT` | `clientSecretEnvVarName` or injected `clientSecretSupplier`; JWT also accepts `clientAssertionProvider`                              |
| `PRIVATE_KEY_JWT`                                                | RSA PEM key referenced by `privateKeyEnvVarName` or injected `clientAssertionProvider`                                               |
| `OIDC`                                                           | Federated credential name and injected `oidcTokenProvider`, explicit token-file configuration, or a supported deployment environment |
| `PKCS7`                                                          | Federated credential name and injected `attestedDocumentProvider` or supported cloud deployment environment                          |
| `PCA`                                                            | Federated credential name, one PEM leaf and a nonempty PEM chain, plus an external assertion provider or matching local private key  |
| `PLUGIN`                                                         | Registered plugin and `pluginName`; OpenAPI configuration is required only by plugins that use it                                    |

See the exported `IDaaSClientConfig` type for authentication-specific field definitions. Await initialization before obtaining providers. Call `getIDaaSCredentialProvider(scope)` for a different authorized scope. `getAccessToken()` returns a bearer token; pass it only to the intended service.

Pass custom sources to `new IDaaSCredentialProviderFactory(options)` or `new IDaaSMachineCredentialProvider(config, options)`. Object and file initialization use the same validation. Injected sources take precedence and do not require unused environment variable names or deployment settings. `clientDeployEnvironment` is validated only when selecting a default OIDC file or built-in PKCS7 source; injected sources and explicit OIDC file configuration ignore it, including unsupported values. For built-in OIDC files, selection is `oidcTokenFilePath`, then the variable named by `oidcTokenFilePathEnvVarName`, then the default ServiceAccount file in a supported Kubernetes environment. A selected empty or unavailable source fails without fallback.

PCA preserves the complete PEM chain, including leaf or root certificates supplied by the caller. The server checks intermediate certificate limits, trust, and authorization. External assertions do not require a local private key. Plugins return a nonempty `accessToken`, finite positive `expiresIn`, and a Bearer `tokenType`; optional `expiresAt` uses Unix seconds. Core takes the earlier of `expiresAt` and the plugin call start plus `expiresIn`, and rejects expired results.

## Token Exchange

Use `provider.tokenExchange({ subjectToken, scope })` with a subject trusted by the IDaaS authorization server. Omitted `subjectTokenType` and `requestedTokenType` default to `urn:ietf:params:oauth:token-type:access_token`; omitted scope uses the provider scope. Explicit subject/actor types, audience, and requested type are preserved. The server decides which combinations and permissions it accepts. AGI delegation uses `actorToken` and `actorTokenType: 'urn:cloud:idaas:params:oauth:token-type:agi:actor-token'`.

Optional `authentication` replaces configured authentication for this exchange. It accepts `clientId`, `clientSecret`, `clientAssertion`, `clientAssertionType`, `applicationFederatedCredentialName`, `clientX509Certificate`, and `x509CertChains`. Only `clientId` defaults to the configured ID; all other required materials must be supplied explicitly. Core does not call configured credential sources or add a Basic header for these requests. Plugin providers require explicit authentication for exchange.

Use `additionalParameters` for request form fields without a named option. Values must be nonempty strings and are form-encoded without changing their contents; server support is still required. Repeating a named exchange/authentication field or `grant_type` is rejected. Empty authentication objects and empty or non-string fields are rejected before sending.

```typescript
const result = await provider.tokenExchange({
  subjectToken,
  actorToken,
  actorTokenType: 'urn:cloud:idaas:params:oauth:token-type:agi:actor-token',
  scope: 'api.example.com|read:file',
  authentication: {
    clientAssertion,
    clientAssertionType: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
  },
  additionalParameters: { custom_field: 'value' },
});
```

Successful exchange results include `scope` and `issuedTokenType`. Each exchange sends a new request and leaves the ordinary credential cache unchanged.

## HTTP and lifecycle

`httpConfiguration.connectTimeout` and `readTimeout` use milliseconds and accept 2000–60000. TLS verification is enabled by default. Connection setup (including TLS) and reading the entire response have independent budgets. The default User-Agent starts with `idaas-typescript-core-sdk/<version> (<platform>; <arch>) Node.js/<node-version>`. Public `getSDKVersion()` returns the same build version, including prerelease labels; source-only builds without version metadata report `unknown`.

The SDK includes the local hostname by default when it can be read safely. Set `userAgentHostname` to use an alias, or set `userAgentHostnameEnabled` to `false` to suppress both the alias and local hostname. Use `userAgentApplicationName`, `userAgentApplicationVersion`, and `userAgentDeploymentEnvironment` to append optional labels. These fields belong to `httpConfiguration` in both JSON and programmatic configuration. Labels are for diagnostics; do not put credentials or personal information in them.

Existing `userAgentMetadata` fields remain supported. Explicit application or alias fields take precedence over the corresponding legacy labels. The legacy `hostname: false` still disables hostname reporting unless `userAgentHostnameEnabled` is explicitly enabled.

Labels are nonblank, contain no ASCII control characters, and are UTF-8 percent-encoded into `app/`, `app-version/`, `deployment/`, and `hostname/` tokens. Each encoded value is limited to 128 characters and the complete Core header to 512 characters. No deployment-name enumeration is imposed.

`httpConfiguration.userAgent` retains its full-replacement behavior (1–512 printable ASCII characters); when supplied, metadata is ignored and no hostname is read. Per-request User-Agent overrides remain case-insensitive. Normal token and Token Exchange calls also supply the header to injected `HttpClient` implementations, which must forward it. Custom callers can use `buildUserAgent(userAgent?, userAgentMetadata?)`.

Keep providers open while requests are in progress. `LENIENT` mode may reuse unexpired credentials after a refresh failure; `STRICT` reports required-refresh failures. Expired credentials are not returned. Close the factory when its work is complete; caller-supplied shared resources remain caller-owned.

HTTP errors expose the status, recognized protocol codes, and available request identifiers. Unknown server codes appear as `HTTP_<status>`. Handle errors using the exported error types, `errorCode`, and `requestId`.

## Examples and support

See [examples](examples) for CommonJS, ESM, and TypeScript samples. Report issues through [GitHub Issues](https://github.com/cloud-idaas/idaas-typescript-core-sdk/issues). Development instructions are in the repository's [contribution guide](https://github.com/cloud-idaas/idaas-typescript-core-sdk/blob/master/CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE).
