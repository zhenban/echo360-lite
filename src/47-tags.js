// ===================================================================================
// Private tags on notes and bookmarks. Local only: they are kept in IndexedDB and never
// sent to Echo360, so only the user sees them (and they go with a backup, M8.6).
//
// The tag list belongs to the course (Echo360 section), so every recording of the course
// offers the same tags; which tags an item has is kept per recording.
//   tags:<section>      { tags: [{ id, name, color }] }   (a few defaults the first time)
//   tagmap:<mediaId>    { <note or bookmark id>: [tag id, ...] }
// ===================================================================================

const TAG_COLORS = ['#f6c343', '#6ea8ff', '#ff6b6b', '#4fd1a5', '#c084fc', '#fb923c', '#94a3b8', '#f472b6'];

class TagStore {
  constructor(lesson, onChange) {
    this.courseKey = 'tags:' + (lesson.sectionId || 'all');
    this.mapKey = lesson.mediaId ? 'tagmap:' + lesson.mediaId : null;
    this.onChange = onChange || (() => {});
    this.tags = [];
    this.map = {};
    this.ready = false;
  }

  async load() {
    const rec = await idbCache.get(this.courseKey);
    if (rec && Array.isArray(rec.tags)) {
      this.tags = rec.tags;
    } else {
      // First use in this course: a few suggestions, which the user may delete.
      this.tags = [
        { id: 'exam', name: t('tagExam'), color: TAG_COLORS[0] },
        { id: 'assignment', name: t('tagAssignment'), color: TAG_COLORS[1] },
        { id: 'confused', name: t('tagConfused'), color: TAG_COLORS[2] },
      ];
      this.saveTags();
    }
    const m = this.mapKey ? await idbCache.get(this.mapKey) : null;
    this.map = m && typeof m === 'object' ? m : {};
    this.ready = true;
    this.onChange();
  }

  saveTags() { idbCache.put(this.courseKey, { tags: this.tags }); }

  saveMap() { if (this.mapKey) idbCache.put(this.mapKey, this.map); }

  byId(id) { return this.tags.find((x) => x.id === id) || null; }

  // Tags of an item, in the order of the tag list (unknown ids, from tags deleted while
  // another recording was open, are skipped).
  of(itemId) {
    const ids = this.map[itemId] || [];
    return this.tags.filter((x) => ids.includes(x.id));
  }

  has(itemId, tagId) { return (this.map[itemId] || []).includes(tagId); }

  toggle(itemId, tagId) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    const ids = (this.map[itemId] || []).filter((x) => this.byId(x));
    const i = ids.indexOf(tagId);
    if (i >= 0) ids.splice(i, 1); else ids.push(tagId);
    if (ids.length) this.map[itemId] = ids; else delete this.map[itemId];
    this.saveMap();
    this.onChange();
  }

  // Forgets an item's tags (the item was deleted).
  forget(itemId) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    if (!this.map[itemId]) return;
    delete this.map[itemId];
    this.saveMap();
  }

  create(name, color) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return null;
    const same = this.tags.find((x) => x.name.toLowerCase() === clean.toLowerCase());
    if (same) return same;
    const tag = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: clean, color: color || TAG_COLORS[this.tags.length % TAG_COLORS.length] };
    this.tags.push(tag);
    this.saveTags();
    this.onChange();
    return tag;
  }

  rename(id, name) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    const tag = this.byId(id);
    const clean = String(name || '').trim().slice(0, 40);
    if (!tag || !clean || clean === tag.name) return;
    tag.name = clean;
    this.saveTags();
    this.onChange();
  }

  recolor(id, color) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    const tag = this.byId(id);
    if (!tag) return;
    tag.color = color;
    this.saveTags();
    this.onChange();
  }

  remove(id) {
    if (!this.ready) return null; // not loaded yet: writing now would overwrite the stored tags
    this.tags = this.tags.filter((x) => x.id !== id);
    for (const k of Object.keys(this.map)) {
      this.map[k] = this.map[k].filter((x) => x !== id);
      if (!this.map[k].length) delete this.map[k];
    }
    this.saveTags();
    this.saveMap();
    this.onChange();
  }
}

// A tag as a small coloured chip.
function tagChip(tag, onclick) {
  const el = h(onclick ? 'button.tagchip' : 'span.tagchip', { onclick: onclick || null, title: tag.name },
    h('i', { style: 'background:' + tag.color }), h('span', { text: tag.name }));
  return el;
}

// The picker for one item: every tag as a toggle, and a field for a new tag.
function tagPicker(store, itemId, onDone) {
  const box = h('div.tagpick', { role: 'group', 'aria-label': t('tagsFor') });
  const render = () => {
    box.textContent = '';
    for (const tag of store.tags) {
      const on = store.has(itemId, tag.id);
      box.append(h('button.tagopt' + (on ? '.on' : ''), { 'aria-pressed': String(on), onclick: () => { store.toggle(itemId, tag.id); render(); } },
        h('i', { style: 'background:' + tag.color }), h('span', { text: tag.name })));
    }
    const input = h('input.input.small', { placeholder: t('newTag'), maxLength: 40, 'aria-label': t('newTag') });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && input.value.trim()) {
        const tag = store.create(input.value);
        if (tag && !store.has(itemId, tag.id)) store.toggle(itemId, tag.id);
        render();
        box.querySelector('input').focus();
      } else if (e.key === 'Escape') onDone();
    });
    box.append(h('div.tagnew', null, input, h('button.link', { text: t('done'), onclick: onDone })));
  };
  render();
  return box;
}

// Managing the course's tags: rename, colour, delete (two clicks), add.
function tagManager(store, onClose) {
  const box = h('div.tagman');
  const render = () => {
    box.textContent = '';
    box.append(h('div.pinfo', { text: t('tagsPrivate') }));
    for (const tag of store.tags) {
      const swatch = h('button.tagswatch', { title: t('tagColor'), 'aria-label': t('tagColor'), style: 'background:' + tag.color });
      swatch.addEventListener('click', () => {
        const i = TAG_COLORS.indexOf(tag.color);
        store.recolor(tag.id, TAG_COLORS[(i + 1) % TAG_COLORS.length]);
        render();
      });
      const name = h('input.input.small', { value: tag.name, maxLength: 40, 'aria-label': t('tagName') });
      name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
      name.addEventListener('change', () => store.rename(tag.id, name.value));
      let armed = 0;
      const del = h('button.link.danger', { text: t('delete') });
      del.addEventListener('click', () => {
        if (!armed) { del.textContent = t('confirmDelete'); armed = setTimeout(() => { armed = 0; del.textContent = t('delete'); }, 3000); return; }
        clearTimeout(armed);
        store.remove(tag.id);
        render();
      });
      box.append(h('div.tagrow', null, swatch, name, del));
    }
    const input = h('input.input.small', { placeholder: t('newTag'), maxLength: 40, 'aria-label': t('newTag') });
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && store.create(input.value)) render(); });
    box.append(h('div.tagrow', null, input, h('button.pbtn', { text: t('addTag'), onclick: () => { if (store.create(input.value)) render(); } })),
      h('div.crow', null, h('span.grow'), h('button.link', { text: t('done'), onclick: onClose })));
  };
  render();
  return box;
}
