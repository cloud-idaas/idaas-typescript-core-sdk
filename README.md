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

| Authentication                                                   | Required credential source                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `CLIENT_SECRET_BASIC`, `CLIENT_SECRET_POST`, `CLIENT_SECRET_JWT` | `clientSecretEnvVarName`                                                                                        |
| `PRIVATE_KEY_JWT`                                                | RSA PEM key referenced by `privateKeyEnvVarName`                                                                |
| `OIDC`                                                           | Federated credential name, deployment environment, and token-file configuration or an injected OIDC provider    |
| `PKCS7`                                                          | Federated credential name, deployment environment, and a supported cloud identity or injected document provider |
| `PCA`                                                            | Federated credential name, matching PEM certificate/private key, and 1–5 intermediate CA certificates           |
| `PLUGIN`                                                         | Registered plugin, `pluginName`, and `openApiEndpoint`                                                          |

See the exported `IDaaSClientConfig` type for authentication-specific field definitions. Await initialization before obtaining providers. Call `getIDaaSCredentialProvider(scope)` for a different authorized scope. `getAccessToken()` returns a bearer token; pass it only to the intended service.

## Token Exchange

Use `provider.tokenExchange({ subjectToken, scope })` with a user access token trusted by the IDaaS authorization server. The target scope must identify one audience; an explicit `audience` must match it. Supported token types are IDaaS access tokens. Token Exchange is unavailable for plugin authentication; actor-token and resource extensions are outside this SDK's supported integration scope.

## HTTP and lifecycle

`httpConfiguration.connectTimeout` and `readTimeout` use milliseconds and accept 2000–60000. TLS verification is enabled by default. The default User-Agent format is `cloud-idaas-typescript/<version> Node.js/<node-version> OS(<platform>; <arch>)`. `httpConfiguration.userAgent` overrides the default SDK/runtime identifier and accepts 1–512 printable ASCII characters. Custom transports can use the public `buildUserAgent()` helper.

Keep providers open while requests are in progress. `LENIENT` mode may reuse unexpired credentials after a refresh failure; `STRICT` reports required-refresh failures. Expired credentials are not returned. Close the factory when its work is complete; caller-supplied shared resources remain caller-owned.

Handle SDK errors using their exported error types, `errorCode`, and available `requestId`. Do not log credential objects or rely on error messages as identifiers.

## Examples and support

See [examples](examples) for CommonJS, ESM, and TypeScript samples. Report issues through [GitHub Issues](https://github.com/cloud-idaas/idaas-typescript-core-sdk/issues). Development instructions are in the repository's [contribution guide](https://github.com/cloud-idaas/idaas-typescript-core-sdk/blob/master/CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE).
