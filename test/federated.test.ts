import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AlibabaCloudEcsAttestedDocumentProvider,
  AwsEc2Pkcs7AttestedDocumentProvider,
  type HttpClient,
  type HttpRequest,
  type IDaaSClientConfig,
  IDaaSMachineCredentialProvider,
  StaticOidcTokenProvider,
  StaticPkcs7AttestedDocumentProvider,
  validatePemCertificates,
} from '../src';

const quiet = { info() {}, warn() {}, error() {} };
function configuration(method: 'OIDC' | 'PKCS7' | 'PCA'): IDaaSClientConfig {
  return {
    clientId: 'client',
    idaasInstanceId: 'instance',
    issuer: 'https://issuer.example',
    tokenEndpoint: 'https://issuer.example/token',
    scope: 'resource|read',
    authnConfiguration: {
      authnMethod: method,
      applicationFederatedCredentialName: 'federated',
      clientDeployEnvironment: 'CUSTOM',
    },
  };
}
function http(observe: (request: HttpRequest) => void): HttpClient {
  return {
    async send(request) {
      observe(request);
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ access_token: 'access', expires_in: 3600, token_type: 'Bearer' }),
      };
    },
  };
}
describe('Federated authentication and metadata contracts', () => {
  for (const method of ['OIDC', 'PKCS7'] as const) {
    it(`${method} uses an injected source with the federation name and matching assertion type`, async () => {
      const provider = new IDaaSMachineCredentialProvider(configuration(method), {
        oidcTokenProvider: new StaticOidcTokenProvider('external-oidc'),
        attestedDocumentProvider: new StaticPkcs7AttestedDocumentProvider('pkcs7'),
        cache: { logger: quiet },
        httpClient: http((request) => {
          const body = new URLSearchParams(request.body);
          assert.equal(body.get('application_federated_credential_name'), 'federated');
          assert.equal(body.get('client_id'), 'client');
          assert.equal(body.get('client_assertion'), method === 'OIDC' ? 'external-oidc' : 'pkcs7');
          assert.equal(
            body.get('client_assertion_type'),
            `urn:cloud:idaas:params:oauth:client-assertion-type:${method === 'OIDC' ? 'id-token-bearer' : 'pkcs7-bearer'}`,
          );
        }),
      });
      assert.equal(await provider.getAccessToken(), 'access');
      provider.close();
    });
  }
  for (const vendor of ['alibaba', 'aws'] as const) {
    it(`${vendor} IMDSv2 retrieves a token first, sends it with document requests, and caches the document`, async () => {
      const requests: HttpRequest[] = [];
      const transport: HttpClient = {
        async send(request) {
          requests.push(request);
          return {
            statusCode: 200,
            headers: {},
            body: request.method === 'PUT' ? 'metadata-token' : 'document',
          };
        },
      };
      const provider =
        vendor === 'alibaba'
          ? new AlibabaCloudEcsAttestedDocumentProvider('instance', {
              httpClient: transport,
              metadataEndpoint: 'http://metadata.test',
            })
          : new AwsEc2Pkcs7AttestedDocumentProvider({
              httpClient: transport,
              metadataEndpoint: 'http://metadata.test',
            });
      assert.equal(await provider.getAttestedDocument(), 'document');
      await provider.getAttestedDocument();
      assert.equal(requests.length, 2);
      assert.equal(requests[0]!.method, 'PUT');
      assert(Object.values(requests[1]!.headers!).includes('metadata-token'));
      if (vendor === 'alibaba')
        assert.equal(
          JSON.parse(new URL(requests[1]!.url).searchParams.get('audience')!).aud,
          'instance',
        );
      provider.close();
    });
  }
  it('sends PCA certificate fields, validates private key matching, and generates assertions with jose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idaas-pca-'));
    const previous = process.env.IDAAS_TEST_PCA_KEY;
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          join(dir, 'key.pem'),
          '-out',
          join(dir, 'cert.pem'),
          '-days',
          '1',
          '-subj',
          '/CN=idaas-sdk-test',
        ],
        { stdio: 'ignore' },
      );
      const pem = await readFile(join(dir, 'cert.pem'), 'utf8');
      const certificate = pem.trim();
      validatePemCertificates(certificate, true);
      validatePemCertificates(Array(5).fill(certificate).join('\n'), true);
      for (const invalid of ['', Array(6).fill(certificate).join('\n'), certificate + ',']) {
        assert.throws(() => validatePemCertificates(invalid, true), {
          errorCode: 'InvalidCertificateChain',
        });
      }
      assert.throws(() =>
        validatePemCertificates(certificate.replace('BEGIN CERTIFICATE', 'BEGIN INVALID'), true),
      );
      process.env.IDAAS_TEST_PCA_KEY = await readFile(join(dir, 'key.pem'), 'utf8');
      const config = configuration('PCA');
      Object.assign(config.authnConfiguration, {
        privateKeyEnvVarName: 'IDAAS_TEST_PCA_KEY',
        clientX509Certificate: certificate,
        x509CertChains: certificate,
      });
      const provider = new IDaaSMachineCredentialProvider(config, {
        cache: { logger: quiet },
        httpClient: http((request) => {
          const form = new URLSearchParams(request.body);
          assert.equal(
            form.get('client_assertion_type'),
            'urn:cloud:idaas:params:oauth:client-assertion-type:x509-jwt-bearer',
          );
          assert.equal(form.get('client_x509'), certificate);
          assert.equal(form.get('client_x509_chain'), certificate);
          assert.equal(form.get('client_assertion')!.split('.').length, 3);
        }),
      });
      assert.equal(await provider.getAccessToken(), 'access');
      provider.close();
      for (const invalidChain of ['', Array(6).fill(certificate).join('\n'), 'not a PEM chain']) {
        let requests = 0;
        const bad = configuration('PCA');
        Object.assign(bad.authnConfiguration, {
          privateKeyEnvVarName: 'IDAAS_TEST_PCA_KEY',
          clientX509Certificate: certificate,
          x509CertChains: invalidChain,
        });
        await assert.rejects(async () => {
          const rejected = new IDaaSMachineCredentialProvider(bad, {
            cache: { logger: quiet },
            httpClient: http(() => {
              requests++;
            }),
          });
          try {
            await rejected.getAccessToken();
          } finally {
            rejected.close();
          }
        });
        assert.equal(requests, 0);
      }
    } finally {
      if (previous === undefined) delete process.env.IDAAS_TEST_PCA_KEY;
      else process.env.IDAAS_TEST_PCA_KEY = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
