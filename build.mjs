// Builds dist/lite-player-for-echo360.user.js from src/ by plain concatenation, so the published file
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
  // A file named in a comment (NN-name.js) must exist: names went stale before.
  for (const f of files) {
    for (const m of readFileSync(join(srcDir, f), 'utf8').matchAll(/\b(\d\d-[a-z0-9-]+\.js)\b/g)) {
      if (!files.includes(m[1])) { console.error(`${f}: names ${m[1]}, which does not exist`); failed = true; }
    }
  }
  // What depends on how the player is run goes through `platform` (05-platform.js), so that
  // an extension can provide its own. Echo360's own sign-in token lives in the page's
  // storage whatever runs the player, so the reporter reads it there.
  const PLATFORM_ONLY = [[/\blocalStorage\b/, 'localStorage'], [/\bindexedDB\b/, 'indexedDB'], [/\bimport\(/, 'import()'], [/\bGM_\w+/, 'GM_ functions'], [/(?<![.\w])Hls\b/, 'Hls']];
  const PLATFORM_ALLOWED = { '05-platform.js': /./, '20-reporter.js': /^localStorage$/ };
  for (const f of files) {
    readFileSync(join(srcDir, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const [re, what] of PLATFORM_ONLY) {
        if (re.test(line) && !(PLATFORM_ALLOWED[f] && PLATFORM_ALLOWED[f].test(what))) { console.error(`${f}:${i + 1}: uses ${what} directly; go through platform (05-platform.js)`); failed = true; }
      }
    });
  }
  if (failed) return null;
  const meta =readFileSync(join(srcDir, 'meta.txt'), 'utf8').replace('{{VERSION}}', version).trimEnd();
  // The pages the script is loaded on (@match) and those it acts on (SITE_HOSTS) must agree.
  const matched = [...new Set([...meta.matchAll(/^\/\/ @match\s+https:\/\/([^/]+)\//gm)].map((m) => m[1]))].sort();
  const sites = JSON.parse(/const SITE_HOSTS = (\[[^\]]*\]);/.exec(readFileSync(join(srcDir, '03-common.js'), 'utf8'))[1].replace(/'/g, '"')).sort();
  if (JSON.stringify(matched) !== JSON.stringify(sites)) {
    console.error('meta.txt @match hosts ' + matched.join(', ') + ' differ from SITE_HOSTS ' + sites.join(', '));
    return null;
  }
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
    new vm.Script(out, { filename: 'lite-player-for-echo360.user.js' });
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
  writeFileSync(join(root, 'dist', 'lite-player-for-echo360.user.js'), r.out);
  console.log(`built dist/lite-player-for-echo360.user.js v${r.version} (${r.count} modules, ${r.out.length} bytes)`);
}
