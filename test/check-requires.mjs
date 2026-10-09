// Every @require in src/meta.txt must carry a SHA-256 hash (#sha256-<base64>, checked by
// Tampermonkey) that matches the file the CDN serves now. Needs the network (CI runs it).
//   npm run check-requires
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const meta = readFileSync(new URL('../src/meta.txt', import.meta.url), 'utf8');
const lines = [...meta.matchAll(/^\/\/ @require\s+(\S+)$/gm)].map((m) => m[1]);
let bad = 0;
for (const line of lines) {
  const [url, frag] = line.split('#');
  const want = frag && /^sha256-([A-Za-z0-9+/=]+)$/.exec(frag);
  if (!want) { console.error('no #sha256-<base64> hash: ' + line); bad++; continue; }
  const r = await fetch(url);
  if (!r.ok) { console.error(url + ': HTTP ' + r.status); bad++; continue; }
  const got = createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('base64');
  if (got !== want[1]) { console.error(url + ': hash ' + got + ', expected ' + want[1]); bad++; } else console.log('ok ' + url);
}
if (!lines.length) { console.error('no @require found'); bad++; }
process.exit(bad ? 1 : 0);
