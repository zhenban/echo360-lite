// Builds dist/echo360-lite.user.js from src/ by plain concatenation, so the published file
// stays readable (Greasy Fork does not accept minified or obfuscated code).
//
//   node build.mjs
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, 'src');

// Source code stays English-only; translated UI strings will live in their own table.
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

// The whole userscript as one string (the tests use it too, to run the player in a
// simulated page). Returns null after reporting what is wrong.
export function assemble() {
  const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort();
  let failed = false;
  const parts = files.map((f) => {
    const text = readFileSync(join(srcDir, f), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (CJK.test(line)) { console.error(`${f}:${i + 1}: CJK characters in source`); failed = true; }
    });
    return `// ---- ${f} ----\n${text.trimEnd()}\n`;
  });
  if (failed) return null;
  const meta = readFileSync(join(srcDir, 'meta.txt'), 'utf8').replace('{{VERSION}}', version).trimEnd();
  const out = `${meta}

/* global Hls */
(function () {
  'use strict';

  const VERSION = '${version}';

${parts.join('\n')}
})();
`;
  // The concatenation must be valid JavaScript (each file alone can be, while the joined
  // script is not): compile it before writing anything.
  try {
    new vm.Script(out, { filename: 'echo360-lite.user.js' });
  } catch (e) {
    console.error('build failed: the joined script does not compile:', e.message);
    return null;
  }
  return { out, version, count: files.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = assemble();
  if (!r) process.exit(1);
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'echo360-lite.user.js'), r.out);
  console.log(`built dist/echo360-lite.user.js v${r.version} (${r.count} modules, ${r.out.length} bytes)`);
}
