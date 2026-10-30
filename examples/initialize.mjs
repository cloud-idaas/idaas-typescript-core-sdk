import { IDaaSCredentialProviderFactory } from '@cloud-idaas/core-sdk';

async function main() {
  await IDaaSCredentialProviderFactory.init();
  try {
    const provider = await IDaaSCredentialProviderFactory.getIDaaSCredentialProvider();
    await provider.getCredential();
  } finally {
    await IDaaSCredentialProviderFactory.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'SDK call failed');
  process.exitCode = 1;
});
