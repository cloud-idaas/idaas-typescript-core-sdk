// Keep executable code, diagnostics, and shared documentation accessible in English.
// README_zh.md keeps Chinese prose while its code examples remain in English.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const roots = ['src', 'test', 'examples', 'scripts', '.github'];
const files = fs.readdirSync(root).filter((name) => /\.(?:md|json|cjs)$/.test(name));
function collect(relative) {
  const entry = path.join(root, relative);
  if (!fs.existsSync(entry)) return;
  if (fs.lstatSync(entry).isSymbolicLink()) return;
  if (fs.statSync(entry).isDirectory()) {
    for (const name of fs.readdirSync(entry)) collect(path.join(relative, name));
  } else if (/\.(?:ts|cts|mts|js|cjs|mjs|json|md|yml|yaml)$/.test(relative)) files.push(relative);
}
for (const relative of roots) collect(relative);
let failures = 0;
for (const relative of files) {
  const lines = fs.readFileSync(path.join(root, relative), 'utf8').split('\n');
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    if (relative === 'README_zh.md') {
      if (/^```/.test(lines[i])) inCode = !inCode;
      if (!inCode) continue;
    }
    if (/\p{Script=Han}/u.test(lines[i])) {
      console.error(`${relative}:${i + 1}: Use English developer-facing text.`);
      failures++;
    }
  }
}
if (failures) process.exitCode = 1;
else console.log('English developer text validation passed.');
