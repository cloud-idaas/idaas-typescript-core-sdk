# IDaaS TypeScript Core SDK

简体中文 | [English](README.md)

在 Node.js 中完成机器身份认证并获取 IDaaS 访问令牌。

## 环境与安装

支持 Node.js 20、22、24，JavaScript CommonJS/ESM 以及 TypeScript 4.7 及以上版本。本 SDK 用于 Node.js，不用于浏览器。请以 npm registry 中的实际可用版本为准；评估尚未发布的版本时，使用提供的安装包归档。

```sh
npm install @cloud-idaas/core-sdk
```

## 使用

设置示例引用的密钥环境变量，并将实例、应用、端点及 scope 占位值替换为应用配置。 将以下 ESM 示例保存为 `example.mjs`，通过 Node.js 运行。CommonJS 使用相同的具名导出和 `require`，异步调用放在 async 函数中。

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

## 配置

提供 `idaasInstanceId`、`clientId`、`issuer`、`tokenEndpoint`、`scope` 和 `authnConfiguration`。Scope 格式为 `audience|permission`；多个条目以空格分隔，只申请应用需要的权限。

可以传入配置对象或 JSON 文件。文件选择顺序为：`init(path)` 显式路径、`CLOUD_IDAAS_CONFIG_PATH`、`~/.cloud_idaas/client-config.json`。实际密钥放在配置所引用的环境变量中。

| 认证方式                                                         | 凭证来源                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `CLIENT_SECRET_BASIC`、`CLIENT_SECRET_POST`、`CLIENT_SECRET_JWT` | `clientSecretEnvVarName`                                        |
| `PRIVATE_KEY_JWT`                                                | `privateKeyEnvVarName` 引用的 RSA PEM 私钥                      |
| `OIDC`                                                           | 联邦凭证名称、部署环境，以及 Token 文件配置或注入的 OIDC 提供者 |
| `PKCS7`                                                          | 联邦凭证名称、部署环境，以及支持的云实例身份或注入的文档提供者  |
| `PCA`                                                            | 联邦凭证名称、匹配的 PEM 证书和私钥，以及 1–5 张中间 CA 证书    |
| `PLUGIN`                                                         | 已注册的插件、`pluginName` 和 `openApiEndpoint`                 |

认证方式专属字段见公开的 `IDaaSClientConfig` 类型。获取提供者前须等待初始化完成。访问其他已授权 scope 时，调用 `getIDaaSCredentialProvider(scope)`。`getAccessToken()` 返回 Bearer Token，仅用于预期的目标服务。

## Token Exchange

通过 `provider.tokenExchange({ subjectToken, scope })` 交换授权服务器信任的 IDaaS 用户访问令牌。目标 scope 只能包含一个 audience，显式 `audience` 必须与其一致。支持的令牌类型为 IDaaS Access Token。插件认证不支持 Token Exchange；actor-token 和 resource 扩展不属于本 SDK 支持的接入范围。

## HTTP 与生命周期

`httpConfiguration.connectTimeout` 和 `readTimeout` 单位为毫秒，取值范围 2000–60000。默认启用 TLS 校验。默认 User-Agent 格式为 `cloud-idaas-typescript/<version> Node.js/<node-version> OS(<platform>; <arch>)`。`httpConfiguration.userAgent` 可替换默认 SDK/运行时标识，接受 1–512 个可打印 ASCII 字符。自定义传输也可使用公开的 `buildUserAgent()` 方法。

请求进行期间应保持提供者可用。`LENIENT` 模式在刷新失败时可继续使用尚未过期的凭证；`STRICT` 模式会报告必要刷新失败。SDK 不返回已过期凭证。使用结束后关闭工厂；调用方注入的共享资源仍由调用方管理。

通过公开错误类型、`errorCode` 和可用的 `requestId` 处理异常。不要记录凭证对象，也不要将错误消息作为稳定标识。

## 示例与支持

[examples](examples) 提供 CommonJS、ESM 和 TypeScript 示例。问题反馈请使用 [GitHub Issues](https://github.com/cloud-idaas/idaas-typescript-core-sdk/issues)，开发说明见源码仓库的[贡献指南](https://github.com/cloud-idaas/idaas-typescript-core-sdk/blob/master/CONTRIBUTING.md)。

## 许可证

[Apache License 2.0](LICENSE)。
