// Validate the packed Core SDK without requiring any companion repositories.
const fs = require('node:fs');
const path = require('node:path');
const {
  assert,
  json,
  save,
  integrity,
  npm,
  run,
  options,
  checkArchive,
} = require('./release-tools.cjs');

try {
  const args = options(process.argv.slice(2));
  assert(
    Object.keys(args).every((key) => key === 'result'),
    'Unknown consumer argument',
  );
  assert(args.result, 'Provide --result pointing to the repository validation pointer');
  const pointer = json(path.resolve(args.result));
  const manifest = json(pointer.manifest);
  assert(
    manifest.mode === 'repository' && manifest.target === 'idaas-typescript-core-sdk',
    'Core consumer validation requires a Core repository candidate',
  );
  const item = manifest.packages.find((pkg) => pkg.name === '@cloud-idaas/core-sdk');
  assert(item && integrity(item.file) === item.integrity, 'Core candidate integrity mismatch');
  checkArchive(item.file);
  const consumer = fs.mkdtempSync(path.join(path.dirname(pointer.manifest), 'consumer-core-'));
  save(path.join(consumer, 'package.json'), {
    name: 'idaas-core-validation-consumer',
    private: true,
    version: '0.0.0',
    devDependencies: { typescript: '4.7.4', '@types/node': '20.14.8' },
  });
  for (const name of ['core-consumer.cts', 'core-consumer.mts', 'runtime-smoke.cjs'])
    fs.copyFileSync(path.join(__dirname, 'fixtures', name), path.join(consumer, name));
  save(path.join(consumer, 'tsconfig.json'), {
    compilerOptions: {
      strict: true,
      skipLibCheck: false,
      target: 'ES2019',
      module: 'Node16',
      moduleResolution: 'Node16',
      noEmit: true,
    },
    include: ['*.cts', '*.mts'],
  });
  npm(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=' + manifest.registry,
      item.file,
    ],
    consumer,
    { capture: true },
  );
  run(
    process.execPath,
    [path.join(consumer, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    consumer,
  );
  const versions = ['20.0.0', '22.0.0', '24.3.0'];
  for (const version of versions) {
    const output = npm(
      [
        'exec',
        '--yes',
        '--registry=' + manifest.registry,
        '--package=node@' + version,
        '--',
        'node',
        'runtime-smoke.cjs',
        '--core-only',
      ],
      consumer,
      { capture: true },
    );
    assert(
      output.includes('Runtime compatibility passed: v' + version + ','),
      'Consumer Node version mismatch',
    );
    fs.writeFileSync(path.join(consumer, 'node-' + version + '.log'), output);
    console.log('Packed Core consumer passed: Node ' + version);
  }
  assert(integrity(item.file) === item.integrity, 'Core candidate changed during validation');
  manifest.coreCompatibility = {
    typescript: '4.7.4',
    nodeVersions: versions,
    commonjs: true,
    esm: true,
  };
  save(pointer.manifest, manifest);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
