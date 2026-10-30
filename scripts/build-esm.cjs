const fs = require('node:fs');
const api = require('../dist/index.js');
const names = Object.keys(api).filter(
  (name) => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name),
);
fs.writeFileSync(
  'dist/index.mjs',
  `import api from './index.js';\n${names.map((name) => `export const ${name} = api.${name};`).join('\n')}\n`,
);
fs.writeFileSync('dist/index.d.mts', "export * from './index.js';\n");
