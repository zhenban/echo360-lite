// ===================================================================================
// Platform: everything that depends on how the player is run. Today that is a userscript
// (Tampermonkey, Violentmonkey) running in the page; a browser extension built from the
// same sources will provide its own version of this object. The rest of the code uses
// only `platform` for these things (the build checks it):
//   - kv: small settings kept on this device (synchronous: settings are needed at start-up;
//     an extension reads a snapshot before it starts the player)
//   - openDb: the IndexedDB database for larger data (slide files, analyses, tags)
//   - libUrl / importLib: the libraries loaded when first needed (pdf.js, Tesseract and
//     its language data), named by their npm path ('pdfjs-dist@6.4.299/build/...'). A
//     userscript fetches them from a CDN; an extension ships them (Manifest V3 does not
//     allow code from elsewhere).
//   - Hls: hls.js (the userscript manager loads it through @require)
//   - save: offer a file to the user
//   - manager: what runs the player, for diagnostics
// ===================================================================================

const platform = {
  name: 'userscript',
  kv: {
    get(name) { try { return localStorage.getItem(name); } catch (e) { return null; } },
    // Throws when storage is full or blocked; callers decide whether that matters.
    set(name, text) { localStorage.setItem(name, text); },
    names() {
      const out = [];
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k != null) out.push(k); } } catch (e) { /* blocked */ }
      return out;
    },
  },
  openDb(name, version) {
    if (typeof indexedDB === 'undefined') return null;
    return indexedDB.open(name, version);
  },
  libUrl(path) { return 'https://cdn.jsdelivr.net/npm/' + path; },
  importLib(path) { return import(this.libUrl(path)); },
  Hls: typeof Hls !== 'undefined' ? Hls : window.Hls,
  save(blob, fileName) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  },
  manager() {
    try {
      if (typeof GM_info !== 'undefined' && GM_info) return (GM_info.scriptHandler || 'userscript manager') + ' ' + (GM_info.version || '');
    } catch (e) { /* not available */ }
    return 'unknown (or development)';
  },
};
