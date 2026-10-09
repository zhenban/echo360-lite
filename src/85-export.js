// ===================================================================================
// Export and backup.
//
// Export: a recording's notes and bookmarks (with their local tags) as Markdown, each with
// a link back to that moment (the lesson page with #t=<seconds>, which this player
// honours). With a slide PDF, the page on screen at each note can go along as a picture;
// the Markdown and the pictures are packed in a zip (for Obsidian and similar). A whole
// course exports one Markdown file per recording (without pictures). Exports never contain
// the video or its address.
//
// Backup: everything that only exists in this browser (tags and which items carry them,
// slide files and their corrections, what was watched, settings and positions), optionally
// with the PDF files, in one JSON file that can be restored in another browser. Analysis
// caches (slides, silence, text on screen) are left out: they are rebuilt.
// ===================================================================================

// ---- zip (stored, no compression: the pictures are PNG already) ----

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: Uint8Array }] -> Blob (application/zip). Names are UTF-8.
function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true);          // UTF-8 names
    head.setUint16(8, 0, true);               // stored
    head.setUint16(10, dosTime, true);
    head.setUint16(12, dosDate, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, f.data.length, true);
    head.setUint32(22, f.data.length, true);
    head.setUint16(26, name.length, true);
    parts.push(head.buffer, name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(cen.buffer, name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((s, x) => s + x.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ---- Markdown ----

function safeName(s) {
  return String(s || 'lecture').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'lecture';
}

// A tag as a Markdown / Obsidian tag: no spaces or punctuation.
function mdTag(name) {
  const s = String(name).trim().replace(/[\s,.;:!?'"()[\]{}#]+/g, '-').replace(/^-+|-+$/g, '');
  return s ? '#' + s : '';
}

function mdEscape(s) {
  return String(s || '').replace(/\r/g, '').replace(/\n/g, '  \n  ');
}

// lec: { title, date (YYYY-MM-DD or ''), url (lesson page), items: [note/bookmark],
// tagsOf(id) -> [{ name }], picture(item) -> relative path or null }
function lectureMarkdown(lec) {
  const long = lec.items.some((x) => x.time >= 3600);
  const lines = ['# ' + lec.title, ''];
  const meta = [lec.date ? tr('mdRecorded', { date: lec.date }) : null, lec.url ? '[' + tr('mdOpen') + '](' + lec.url + ')' : null].filter(Boolean);
  if (meta.length) lines.push(meta.join(' · '), '');
  const items = lec.items.filter((x) => x.type === 'note' || x.type === 'bookmark');
  if (!items.length) lines.push('_' + tr('mdNothing') + '_');
  for (const x of items) {
    const when = x.time != null ? '[' + fmtTime(x.time, long) + '](' + lec.url + '#t=' + Math.floor(x.time) + ')' : tr('mdNoTime');
    const tags = lec.tagsOf(x.id).map((g) => mdTag(g.name)).filter(Boolean).join(' ');
    const body = x.type === 'note' ? mdEscape(x.text) : '🔖 ' + tr('markerBookmark');
    lines.push('- **' + when + '** ' + body + (tags ? ' ' + tags : ''));
    const pic = lec.picture ? lec.picture(x) : null;
    if (pic) lines.push('  ', '  ![](' + encodeURI(pic).replace(/\(/g, '%28').replace(/\)/g, '%29') + ')');
  }
  lines.push('', '_' + tr('mdFooter', { date: new Date().toISOString().slice(0, 10) }) + '_', '');
  return lines.join('\n');
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// Date of a lesson from its id (G_..._2026-09-15T16:05:00.000_...), '' if none.
function lessonDate(lessonId) {
  const m = /_(\d{4}-\d{2}-\d{2})T/.exec(String(lessonId || ''));
  return m ? m[1] : '';
}

function lessonPageUrl(lessonId) {
  return location.origin + '/lesson/' + seg(lessonId) + '/classroom';
}

class Exporter {
  constructor(player) {
    this.p = player;
  }

  // This recording; with `pictures`, the slide page at each note (needs a slide PDF).
  async lecture(pictures) {
    const p = this.p;
    const l = p.lesson;
    const items = p.notes ? p.notes.items.filter((x) => x.type !== 'flag') : [];
    const base = (lessonDate(l.lessonId) ? lessonDate(l.lessonId) + ' ' : '') + safeName(l.title);
    const files = [];
    const pics = new Map();   // page index -> file name
    let picture = null;
    const deck = p.deck;
    if (pictures && deck && deck.pages.length) {
      for (const x of items) {
        if (x.time == null) continue;
        const i = deck.pageAt(x.time);
        if (i < 0 || pics.has(i)) continue;
        const pg = deck.pages[i];
        const name = base + '/' + safeName(pg.file.replace(/\.pdf$/i, '')) + ' p' + pg.num + '.png';
        const c = await deck.render(i, 1600);
        const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
        files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
        pics.set(i, name);
      }
      picture = (x) => (x.time == null ? null : pics.get(deck.pageAt(x.time)) || null);
    }
    const md = lectureMarkdown({
      title: l.title, date: lessonDate(l.lessonId), url: lessonPageUrl(l.lessonId), items,
      tagsOf: (id) => (p.tags ? p.tags.of(id) : []), picture,
    });
    const mdBytes = new TextEncoder().encode(md);
    if (!files.length) { downloadBlob(new Blob([mdBytes], { type: 'text/markdown' }), base + '.md'); return { notes: items.length, pictures: 0 }; }
    files.unshift({ name: base + '.md', data: mdBytes });
    downloadBlob(makeZip(files), base + '.zip');
    return { notes: items.length, pictures: files.length - 1 };
  }

  // Every recording of the course with notes or bookmarks, one Markdown file each.
  async course(onProgress) {
    const p = this.p;
    const section = p.lesson.sectionId;
    if (!section) throw new Error('no course');
    const list = (await fetchSyllabus(section)).map((x) => x.lesson).filter((x) => x && x.lesson && x.hasVideo);
    const files = [];
    const tagStore = new TagStore({ sectionId: section, mediaId: null });
    await tagStore.load();
    for (let k = 0; k < list.length; k++) {
      const x = list[k];
      if (onProgress) onProgress(k, list.length);
      const lid = x.lesson.id;
      const mid = x.medias && x.medias[0] && x.medias[0].id;
      let items = [];
      try { items = await new Echo360Api({ lessonId: lid, mediaId: mid }).notes(); } catch (e) { continue; }
      if (!items.length) continue;
      const map = mid ? (await idbCache.get('tagmap:' + mid)) || {} : {};
      const tagsOf = (id) => tagStore.tags.filter((g) => (map[id] || []).includes(g.id));
      items.sort((a, b) => (a.time == null ? -1 : a.time) - (b.time == null ? -1 : b.time));
      const title = x.lesson.name || x.medias[0].title || lid;
      const md = lectureMarkdown({ title, date: lessonDate(lid), url: lessonPageUrl(lid), items, tagsOf });
      files.push({ name: (lessonDate(lid) ? lessonDate(lid) + ' ' : '') + safeName(title) + '.md', data: new TextEncoder().encode(md) });
    }
    if (!files.length) return 0;
    // Same names (two recordings on one day with one title): number them.
    const seen = new Map();
    for (const f of files) { const n = seen.get(f.name) || 0; seen.set(f.name, n + 1); if (n) f.name = f.name.replace(/\.md$/, ' (' + (n + 1) + ').md'); }
    downloadBlob(makeZip(files), safeName(p.lesson.courseName || 'course') + ' notes.zip');
    return files.length;
  }
}

// ---- backup ----

const BACKUP_KEYS = /^(tags|tagmap|deck|deckref|watched|screenpick):/;

// The shape each restored IndexedDB entry must have (anything else is skipped, so a
// damaged backup cannot plant data that breaks a later visit).
const isStr = (x) => typeof x === 'string' && x.length < 2000;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const BACKUP_DB_SHAPES = {
  tags: (v) => v && Array.isArray(v.tags) && v.tags.every((g) => g && isStr(g.id) && isStr(g.name) && isStr(g.color)),
  tagmap: (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((a) => Array.isArray(a) && a.every(isStr)),
  deck: (v) => v && Array.isArray(v.files) && v.files.every((f) => f && isStr(f.hash) && isStr(f.name))
    && (v.fixes == null || (Array.isArray(v.fixes) && v.fixes.every((x) => x && isNum(x.a) && isNum(x.b) && isStr(String(x.page))))),
  deckref: (v) => Array.isArray(v) && v.every(isStr),
  watched: (v) => v && isNum(v.d) && Array.isArray(v.r) && v.r.every((x) => Array.isArray(x) && x.length === 2 && isNum(x[0]) && isNum(x[1])) && (v.e == null || isNum(v.e)),
  deckfile: (v) => v instanceof Blob,
  screenpick: (v) => v && isNum(v.index),
};

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function makeBackup(withPdfs) {
  const out = { app: 'lite-player-for-echo360', v: 1, created: new Date().toISOString(), local: {}, db: {} };
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const key = k && k.startsWith(NS) ? k.slice(NS.length) : null;
    if (key && BACKUP_LOCAL.some((x) => x.match(key))) out.local[key] = localStorage.getItem(k);
  }
  for (const k of await idbCache.keys()) {
    const key = String(k);
    const pdf = key.startsWith('deckfile:');
    if (!BACKUP_KEYS.test(key) && !(pdf && withPdfs)) continue;
    const v = await idbCache.get(key);
    out.db[key] = v instanceof Blob ? { $blob: await blobToBase64(v), type: v.type } : v;
  }
  return out;
}

// Restores a backup: its entries replace the ones with the same keys. Everything is checked
// first; the IndexedDB entries are then written in one transaction (all or none), and only
// then the settings. Returns the number of entries written.
async function restoreBackup(data, db = idbCache) {
  if (!data || data.app !== 'lite-player-for-echo360' || data.v !== 1 || !data.db || typeof data.db !== 'object') throw new Error(tr('backupInvalid'));
  // Settings and positions: only known keys, each validated like the player does (a
  // damaged value becomes the default instead of breaking every later visit).
  const local = [];
  for (const [k, v] of Object.entries(data.local && typeof data.local === 'object' ? data.local : {})) {
    const rule = BACKUP_LOCAL.find((x) => x.match(k));
    if (!rule) continue;
    let parsed = null;
    try { parsed = JSON.parse(v); } catch (e) { parsed = null; }
    const clean = rule.clean(parsed);
    if (clean != null) local.push([k, clean]);
  }
  const entries = [];
  for (const [k, v] of Object.entries(data.db)) {
    if (!BACKUP_KEYS.test(k) && !k.startsWith('deckfile:')) continue;
    let val = v;
    if (v && typeof v === 'object' && typeof v.$blob === 'string') {
      const bin = atob(v.$blob);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      val = new Blob([bytes], { type: v.type || 'application/octet-stream' });
    }
    const shape = BACKUP_DB_SHAPES[k.split(':')[0]];
    if (shape && shape(val)) entries.push([k, val]);
  }
  await db.putMany(entries);
  let n = entries.length;
  for (const [k, clean] of local) {
    try { localStorage.setItem(NS + k, JSON.stringify(clean)); n++; } catch (e) { /* storage full */ }
  }
  return n;
}
