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

| 认证方式                                                         | 凭证来源                                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `CLIENT_SECRET_BASIC`、`CLIENT_SECRET_POST`、`CLIENT_SECRET_JWT` | `clientSecretEnvVarName` 或注入的 `clientSecretSupplier`；JWT 还支持 `clientAssertionProvider` |
| `PRIVATE_KEY_JWT`                                                | `privateKeyEnvVarName` 引用的 RSA PEM 私钥或注入的 `clientAssertionProvider`                   |
| `OIDC`                                                           | 联邦凭证名称，以及注入的 `oidcTokenProvider`、显式 Token 文件配置或支持的部署环境              |
| `PKCS7`                                                          | 联邦凭证名称，以及注入的 `attestedDocumentProvider` 或支持的云部署环境                         |
| `PCA`                                                            | 联邦凭证名称、一张 PEM 叶子证书和非空 PEM 链，以及外部断言提供者或匹配的本地私钥               |
| `PLUGIN`                                                         | 已注册的插件和 `pluginName`；仅使用 OpenAPI 的插件需要相应配置                                 |

认证方式专属字段见公开的 `IDaaSClientConfig` 类型。获取提供者前须等待初始化完成。访问其他已授权 scope 时，调用 `getIDaaSCredentialProvider(scope)`。`getAccessToken()` 返回 Bearer Token，仅用于预期的目标服务。

通过 `new IDaaSCredentialProviderFactory(options)` 或 `new IDaaSMachineCredentialProvider(config, options)` 注入来源。对象和文件初始化采用相同校验。注入来源优先，不要求未使用的环境变量名或部署环境。仅选择默认 OIDC 文件或内置 PKCS7 来源时校验 `clientDeployEnvironment`；注入来源或显式 OIDC 文件配置会忽略该字段，包括不受支持的值。内置 OIDC 文件依次选择 `oidcTokenFilePath`、`oidcTokenFilePathEnvVarName` 指定的变量、受支持 Kubernetes 环境的默认 ServiceAccount 文件；选中来源为空或不可用时失败，不回退。

PCA 完整保留调用方提供的 PEM 链，包括其中的叶子或根证书。服务端检查中间证书数量、信任及授权；外部断言不要求本地私钥。插件返回非空 `accessToken`、有限正数 `expiresIn` 和 Bearer `tokenType`，可选 `expiresAt` 使用 Unix 秒。Core 取 `expiresAt` 与插件调用开始加 `expiresIn` 的较早期限，并拒绝过期结果。

## Token Exchange

通过 `provider.tokenExchange({ subjectToken, scope })` 交换授权服务器信任的主体。省略 `subjectTokenType` 和 `requestedTokenType` 时沿用 `urn:ietf:params:oauth:token-type:access_token`，省略 scope 时沿用提供者 scope。显式主体/actor 类型、audience 和请求类型保留原值，由服务端决定组合及权限是否受理。AGI 委托使用 `actorToken` 及 `actorTokenType: 'urn:cloud:idaas:params:oauth:token-type:agi:actor-token'`。

可选的 `authentication` 整组替代本次交换的配置认证，支持 `clientId`、`clientSecret`、`clientAssertion`、`clientAssertionType`、`applicationFederatedCredentialName`、`clientX509Certificate` 和 `x509CertChains`。仅 `clientId` 缺省时沿用配置 ID，其余必要材料须显式提供。这些请求不调用配置中的凭据来源，也不附加 Basic 头。插件提供者执行交换时必须提供显式认证。

`additionalParameters` 用于尚无单列选项的请求表单字段，值须为非空字符串，按原值进行表单编码；服务端仍须支持该字段。重复填写已有交换/认证字段或 `grant_type` 会被拒绝。空认证对象、空字段和非字符串字段在发送前报错。

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

成功的交换结果包含 `scope` 和 `issuedTokenType`。每次交换独立发送请求，不改变普通凭据缓存。

## HTTP 与生命周期

`httpConfiguration.connectTimeout` 和 `readTimeout` 单位为毫秒，取值范围 2000–60000。默认启用 TLS 校验。建立连接（含 TLS）和读取完整响应分别计时。默认 User-Agent 以 `idaas-typescript-core-sdk/<version> (<platform>; <arch>) Node.js/<node-version>` 开头。公开的 `getSDKVersion()` 返回相同的构建版本，保留预发布标签；缺少版本元数据的源码构建返回 `unknown`。

SDK 默认在可安全读取时携带本机主机名。用 `userAgentHostname` 指定别名，或设置 `userAgentHostnameEnabled: false` 同时关闭别名和本机主机名。用 `userAgentApplicationName`、`userAgentApplicationVersion` 和 `userAgentDeploymentEnvironment` 追加选填标签。JSON 文件和编程配置均将这些字段放在 `httpConfiguration` 中。标签仅用于诊断，请勿填入凭据或个人信息。

既有 `userAgentMetadata` 字段继续可用。显式应用或别名字段优先于对应的旧标签。旧配置中的 `hostname: false` 仍可关闭主机名，除非显式开启 `userAgentHostnameEnabled`。

标签不能为空白或包含 ASCII 控制字符，以 UTF-8 百分号编码形成 `app/`、`app-version/`、`deployment/`、`hostname/` 标记。每个编码值最多 128 字符，Core 完整请求头最多 512 字符，不限制部署环境名称枚举。

`httpConfiguration.userAgent` 保留完整替换行为（1–512 个可打印 ASCII 字符）；设置后忽略元数据且不读取主机名。单次请求的 User-Agent 覆盖仍不区分大小写。普通取令牌和 Token Exchange 均向注入的 `HttpClient` 传递请求头，自定义实现负责转发。其他调用方可使用 `buildUserAgent(userAgent?, userAgentMetadata?)`。

请求进行期间应保持提供者可用。`LENIENT` 模式在刷新失败时可继续使用尚未过期的凭证；`STRICT` 模式会报告必要刷新失败。SDK 不返回已过期凭证。使用结束后关闭工厂；调用方注入的共享资源仍由调用方管理。

HTTP 异常公开状态、已知协议错误码和可用的请求标识。未知服务端错误码以 `HTTP_<status>` 表示。通过公开错误类型、`errorCode` 和 `requestId` 处理异常。

## 示例与支持

[examples](examples) 提供 CommonJS、ESM 和 TypeScript 示例。问题反馈请使用 [GitHub Issues](https://github.com/cloud-idaas/idaas-typescript-core-sdk/issues)，开发说明见源码仓库的[贡献指南](https://github.com/cloud-idaas/idaas-typescript-core-sdk/blob/master/CONTRIBUTING.md)。

## 许可证

[Apache License 2.0](LICENSE)。
