// ===================================================================================
// Small helpers shared by several parts (each used to be written out in two or more
// places): building elements, canvases, the site's hosts, Echo360 URLs, durations.
// ===================================================================================

// Pages this script runs on. Must list the same hosts as the @match lines in meta.txt
// (the build checks it): a page outside them never loads the script anyway.
const SITE_HOSTS = ['echo360.net.au'];

function isEcho360Host() {
  return SITE_HOSTS.includes(location.hostname);
}

// An element: el('button.btn.primary', { title: 'x', onclick }, 'text', child, ...).
// on* functions are guarded (an error there is reported, not thrown into the page).
function el(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const elem = document.createElement(tag || 'div');
  if (classes.length) elem.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') elem.addEventListener(k.slice(2), guard(v));
      else if (k === 'text') elem.textContent = v;
      else if (k in elem && typeof v !== 'string') elem[k] = v;
      else elem.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c != null && c !== false) elem.append(c);
  return elem;
}

// A delete button that needs a second click within 3 s (it says "Click again to delete"
// in between). onConfirm(event) gets the second click, the user action for the write.
function confirmButton(label, onConfirm) {
  let armed = 0;
  const b = el('button.link.danger', { text: label });
  b.addEventListener('click', guard((e) => {
    if (!armed) {
      b.textContent = tr('confirmDelete');
      armed = setTimeout(() => { armed = 0; b.textContent = label; }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    b.textContent = label;
    onConfirm(e);
  }));
  return b;
}

// A canvas to draw on off screen (an OffscreenCanvas where there is one).
function makeCanvas(w, h) {
  return typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
}

// Path segment as the original player builds it: Echo360 ids are used verbatim (they
// contain ':' and '.'), only characters that would break the URL are escaped.
function seg(id) {
  return String(id).replace(/[^\w.:~-]/g, encodeURIComponent);
}

// URL of Echo360's preview picture at `t` (one of set.timesInSeconds) of a thumbnail set.
function thumbUrlOf(set, t) {
  return set.baseUri + '/' + t + '.' + set.extension;
}

// The recording's length: the video's once it knows it, else what the page said.
function mediaDuration(video, lesson) {
  const v = video.duration;
  if (isFinite(v) && v > 0) return v;
  return isFinite(lesson.duration) ? lesson.duration : 0;
}

// The user asked the browser to save data: no background downloads.
function saveDataOn() {
  return !!(navigator.connection && navigator.connection.saveData);
}

// A course's recordings as listed by Echo360 (the JSON `data` array). Rejects when the
// list cannot be had.
async function fetchSyllabus(section) {
  const r = await fetch('/section/' + encodeURIComponent(section) + '/syllabus', { credentials: 'include', headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return j && Array.isArray(j.data) ? j.data : [];
}
