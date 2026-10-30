// Generate a build-time version constant; published clients never read package metadata at runtime.
const fs = require('node:fs');
const path = require('node:path');
const prettier = require('prettier');

(async () => {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || !/^[0-9A-Za-z.+-]+$/.test(pkg.version))
    throw new Error('Invalid SDK package version');
  const config = JSON.parse(fs.readFileSync(path.join(root, '.prettierrc.json'), 'utf8'));
  const source = await prettier.format(
    '// Generated from package.json by scripts/build-version.cjs. Do not edit.\n' +
      'export const SDK_VERSION: string = ' +
      JSON.stringify(pkg.version) +
      ';\n',
    { ...config, parser: 'typescript' },
  );
  const target = path.join(root, 'src', 'sdk-version.ts');
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== source)
    fs.writeFileSync(target, source);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
