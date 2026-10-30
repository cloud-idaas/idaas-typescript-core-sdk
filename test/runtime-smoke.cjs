const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sdk = require('@cloud-idaas/core-sdk');

async function main() {
  const esm = await import('@cloud-idaas/core-sdk');
  assert.equal(sdk.IDaaSCredentialProviderFactory, esm.IDaaSCredentialProviderFactory);
  const context = { clientId: 'runtime-client', tokenEndpoint: 'https://issuer.example/token' };
  const secret = '0123456789abcdef0123456789abcdef';
  const hmac = await new sdk.StaticClientSecretAssertionProvider(secret).getClientAssertion(
    context,
  );
  const [header, payload, signature] = hmac.split('.');
  assert.equal(
    crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'),
    signature,
  );
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.aud, context.tokenEndpoint);
  assert.equal(claims.exp - claims.iat, 600);
  for (const type of ['rsa', 'ec']) {
    const pair =
      type === 'rsa'
        ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
        : crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const provider = new sdk.StaticPrivateKeyAssertionProvider(
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    const [first, second, third] = (await provider.getClientAssertion(context)).split('.');
    assert(
      crypto.verify(
        'sha256',
        Buffer.from(`${first}.${second}`),
        { key: pair.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(third, 'base64url'),
      ),
    );
  }
  console.info(`Runtime compatibility passed: ${process.version}, HS256/RS256/ES256, CJS/ESM`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
