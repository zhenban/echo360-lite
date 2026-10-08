// ===================================================================================
// Notes tab: private notes, bookmarks and "didn't understand" flags, sorted by time.
// Data is loaded once at start (it also feeds the progress-bar markers); the list DOM is
// only rebuilt while the tab is visible. Notes and bookmarks can carry local tags
// (56-tags.js).
// ===================================================================================

const NOTE_FILTERS = ['all', 'note', 'bookmark', 'flag'];

class NotesPane {
  constructor(player, pane, api, canFlag) {
    this.p = player;
    this.pane = pane;
    this.api = api;
    this.canFlag = canFlag;
    this.items = [];
    this.filter = 'all';
    this.tagFilter = '';      // '' all, a tag id, or '-' untagged
    this.tags = player.tags;
    this.picking = null;      // item id whose tag picker is open
    this.managing = false;
    this.visible = false;
    this.dirty = true;
    this.d = new Disposer();
    this.build();
  }

  // Resolves true when notes are available for this recording.
  async load() {
    const [notes, flags] = await Promise.allSettled([this.api.notes(), this.canFlag ? this.api.flags() : Promise.resolve([])]);
    if (notes.status !== 'fulfilled') {
      log.info('notes unavailable:', notes.reason && notes.reason.message);
      return false;
    }
    this.items = notes.value.concat(flags.status === 'fulfilled' ? flags.value : []);
    this.sort();
    this.changed();
    return true;
  }

  sort() {
    this.items.sort((a, b) => (a.time == null ? -1 : a.time) - (b.time == null ? -1 : b.time));
  }

  changed() {
    this.dirty = true;
    if (this.visible) this.render();
    this.p.updateMarkers();
  }

  build() {
    const timeLabel = el('span');
    this.composerTime = timeLabel;
    this.textarea = el('textarea.input', { rows: 3, maxLength: 5000, 'aria-label': tr('addNote') });
    this.addBtn = el('button.pbtn.primary', { text: tr('addNote'), onclick: (e) => this.addNote(e) });
    this.d.listen(this.textarea, 'keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.addNote(e); }
    });
    this.d.listen(this.textarea, 'focus', () => this.updatePlaceholder());
    this.select = el('select.input.small', { 'aria-label': tr('filterAll') });
    for (const f of NOTE_FILTERS) {
      const label = { all: tr('filterAll'), note: tr('filterNotes'), bookmark: tr('filterBookmarks'), flag: tr('filterFlags') }[f];
      if (f === 'flag' && !this.canFlag) continue;
      this.select.append(el('option', { value: f, text: label }));
    }
    this.d.listen(this.select, 'change', () => { this.filter = this.select.value; this.render(); });
    this.tagSelect = el('select.input.small', { 'aria-label': tr('filterTags') });
    this.d.listen(this.tagSelect, 'change', () => { this.tagFilter = this.tagSelect.value; this.render(); });
    this.manageBtn = el('button.link', { text: tr('manageTags'), onclick: () => { this.managing = !this.managing; this.exporting = false; this.render(); } });
    this.exportBtn = el('button.link', { text: tr('exportMenu'), onclick: () => { this.exporting = !this.exporting; this.managing = false; this.render(); } });
    this.manageBox = el('div');
    this.errorEl = el('div.perror', { hidden: true });
    this.list = el('div.plist');
    this.pane.append(
      el('div.pinfo', { text: tr('notesPrivate') }),
      el('div.composer', null, this.textarea, el('div.crow', null, timeLabel, el('span.grow'), this.addBtn)),
      el('div.ptools', null, this.select, this.tagSelect, el('span.grow'), this.manageBtn, this.exportBtn),
      this.manageBox,
      this.errorEl,
      this.list,
    );
  }

  updatePlaceholder() {
    const at = fmtTime(this.p.video.currentTime, this.p.duration() >= 3600);
    this.textarea.placeholder = tr('addNotePlaceholder', { time: at });
  }

  show(on) {
    this.visible = on;
    if (on) { this.updatePlaceholder(); if (this.dirty) this.render(); }
  }

  showError(msg) {
    this.errorEl.textContent = msg;
    this.errorEl.hidden = !msg;
  }

  fail(e) {
    log.warn('write failed', e);
    this.showError(tr('saveFailed', { error: e.message || e }));
    this.p.toast(tr('saveFailed', { error: e.message || e }));
  }

  renderTagFilter() {
    const sel = this.tagSelect;
    const keep = this.tagFilter;
    sel.textContent = '';
    sel.append(el('option', { value: '', text: tr('allTags') }));
    for (const tag of this.tags.tags) sel.append(el('option', { value: tag.id, text: tag.name }));
    sel.append(el('option', { value: '-', text: tr('untagged') }));
    this.tagFilter = keep && (keep === '-' || this.tags.byId(keep)) ? keep : '';
    sel.value = this.tagFilter;
  }

  tagMatch(item) {
    if (!this.tagFilter) return true;
    if (item.type === 'flag') return false;
    const ids = this.tags.of(item.id);
    return this.tagFilter === '-' ? !ids.length : ids.some((x) => x.id === this.tagFilter);
  }

  render() {
    this.dirty = false;
    const long = this.p.duration() >= 3600;
    this.renderTagFilter();
    this.manageBox.textContent = '';
    if (this.managing) this.manageBox.append(tagManager(this.tags, () => { this.managing = false; this.render(); }));
    if (this.exporting) this.manageBox.append(this.exportPanel());
    const shown = this.items.filter((x) => (this.filter === 'all' || x.type === this.filter) && this.tagMatch(x));
    const frag = document.createDocumentFragment();
    if (!shown.length) frag.append(el('div.pempty', { text: tr('noNotes') }));
    for (const item of shown) frag.append(this.renderItem(item, long));
    this.list.textContent = '';
    this.list.append(frag);
  }

  renderItem(item, long) {
    const label = { note: tr('markerNote'), bookmark: tr('markerBookmark'), flag: tr('markerFlag') }[item.type];
    const time = item.time != null
      ? el('button.chiptime', { text: fmtTime(item.time, long), title: label, onclick: () => this.p.seek(item.time) })
      : null;
    const head = el('div.ihead', null, el('span.kind.k-' + item.type, { text: label }), time, el('span.grow'));
    const body = item.type === 'note' ? el('div.ibody', { text: item.text }) : null;
    let tags = null;
    if (item.type !== 'flag') {
      const open = () => { this.picking = this.picking === item.id ? null : item.id; this.render(); };
      tags = el('div.itags', null, ...this.tags.of(item.id).map((tag) => tagChip(tag, open)),
        el('button.link.addtag', { text: tr('addTagShort'), title: tr('tagsFor'), onclick: open }));
      if (this.picking === item.id) tags.append(tagPicker(this.tags, item.id, () => { this.picking = null; this.render(); }));
    }
    const actions = el('div.iactions');
    if (item.type === 'note') actions.append(el('button.link', { text: tr('edit'), onclick: () => this.startEdit(item, card) }));
    actions.append(this.deleteButton(item));
    const card = el('div.card.k-' + item.type, { 'data-id': item.id }, head, body, tags, actions);
    return card;
  }

  // Two clicks within 3 s delete; the second click is the user action sent with the write.
  deleteButton(item) {
    const label = item.type === 'flag' ? tr('remove') : tr('delete');
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
      this.remove(e, item);
    }));
    return b;
  }

  startEdit(item, card) {
    const area = el('textarea.input', { rows: 3, maxLength: 5000 });
    area.value = item.text;
    const save = el('button.pbtn.primary', { text: tr('save') });
    const cancel = el('button.pbtn', { text: tr('cancel'), onclick: () => this.render() });
    save.addEventListener('click', guard((e) => this.once(async () => {
      const text = area.value.trim();
      if (!text) return;
      save.disabled = true;
      try {
        await this.api.updateNote(e, item, text);
        item.text = text;
        this.showError('');
        this.changed();
      } catch (err) { save.disabled = false; this.fail(err); }
    })));
    card.querySelector('.ibody').replaceWith(el('div.composer', null, area, el('div.crow', null, el('span.grow'), cancel, save)));
    card.querySelector('.iactions').hidden = true;
    area.focus();
  }

  // One write at a time for the whole tab (see DiscussionPane.write): a second Ctrl+Enter
  // or click while a request is on its way does nothing.
  async once(fn) {
    if (this.busy) return undefined;
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  addNote(e) {
    return this.once(() => this.addNoteNow(e));
  }

  async addNoteNow(e) {
    const text = this.textarea.value.trim();
    if (!text) return;
    this.addBtn.disabled = true;
    try {
      const note = await this.api.addNote(e, { text, time: this.p.video.currentTime, num: this.count('note') + 1 });
      this.textarea.value = '';
      this.items.push(note);
      this.sort();
      this.showError('');
      this.changed();
    } catch (err) {
      this.fail(err);
    } finally {
      this.addBtn.disabled = false;
    }
  }

  count(type) { return this.items.filter((x) => x.type === type).length; }

  // Resolves to the new bookmark, or null if it could not be added (or another write was
  // still on its way).
  addBookmark(e) {
    return this.once(async () => {
      const time = this.p.video.currentTime;
      try {
        const note = await this.api.addNote(e, { bookmark: true, time, num: this.count('bookmark') + 1 });
        this.items.push(note);
        this.sort();
        this.changed();
        this.p.toast(tr('bookmarkedAt', { time: fmtTime(time) }), tr('undo'), (ev) => this.remove(ev, note));
        return note;
      } catch (err) { this.fail(err); return null; }
    }).then((x) => x || null);
  }

  flagAt(time) {
    const scene = Math.floor(time / FLAG_SCENE_SECONDS) * FLAG_SCENE_SECONDS;
    return this.items.find((x) => x.type === 'flag' && x.time === scene) || null;
  }

  toggleFlag(e) {
    return this.once(() => this.toggleFlagNow(e));
  }

  async toggleFlagNow(e) {
    if (!this.canFlag) return;
    const time = this.p.video.currentTime;
    const existing = this.flagAt(time);
    try {
      if (existing) {
        await this.api.removeFlag(e, existing);
        this.items = this.items.filter((x) => x !== existing);
        this.p.toast(tr('flagRemoved', { time: fmtTime(existing.time) }));
      } else {
        await this.api.addFlag(e, time);
        const scene = Math.floor(time / FLAG_SCENE_SECONDS) * FLAG_SCENE_SECONDS;
        this.items.push({ id: 'flag-' + scene / FLAG_SCENE_SECONDS, type: 'flag', time: scene, createdAt: new Date().toISOString() });
        this.sort();
        this.p.toast(tr('flagAdded', { time: fmtTime(scene) }));
      }
      this.changed();
      this.p.renderFlagButton();
    } catch (err) { this.fail(err); }
  }

  remove(e, item) {
    return this.once(() => this.removeNow(e, item));
  }

  async removeNow(e, item) {
    try {
      if (item.type === 'flag') await this.api.removeFlag(e, item);
      else await this.api.deleteNote(e, item);
      this.items = this.items.filter((x) => x !== item);
      this.tags.forget(item.id);
      this.showError('');
      this.changed();
      this.p.renderFlagButton();
    } catch (err) { this.fail(err); }
  }

  markers() {
    return this.items.filter((x) => x.time != null).map((x) => {
      const tags = x.type === 'flag' ? [] : this.tags.of(x.id);
      const base = x.type === 'note' ? tr('markerNote') + ': ' + x.text : x.type === 'bookmark' ? tr('markerBookmark') : tr('markerFlag');
      return {
        time: x.time,
        kind: x.type,
        color: tags.length ? tags[0].color : null,
        label: tags.length ? base + ' [' + tags.map((g) => g.name).join(', ') + ']' : base,
      };
    });
  }

  openExport() {
    this.exporting = true;
    this.managing = false;
    this.p.sidebar.open('notes');
    this.render();
  }

  // Export (Markdown, zip) and backup / restore of what only lives in this browser.
  exportPanel() {
    const ex = new Exporter(this.p);
    const hasPdf = !!(this.p.deck && this.p.deck.pages.length);
    const pics = el('input', { type: 'checkbox', checked: hasPdf, disabled: !hasPdf });
    const pdfs = el('input', { type: 'checkbox' });
    const busy = async (btn, fn) => {
      btn.disabled = true;
      try { await fn(); } catch (e) { this.p.toast(tr('exportFailed', { msg: (e && e.message) || e })); } finally { btn.disabled = false; }
    };
    const one = el('button.pbtn.primary', { text: tr('exportLecture') });
    one.addEventListener('click', guard(() => busy(one, async () => {
      const r = await ex.lecture(pics.checked);
      this.p.toast(tr('exportedLecture', { n: r.notes, p: r.pictures }));
    })));
    const all = el('button.pbtn', { text: tr('exportCourse') });
    all.addEventListener('click', guard(() => busy(all, async () => {
      const n = await ex.course((k, total) => { all.textContent = tr('exportCourseProgress', { k: k + 1, n: total }); });
      all.textContent = tr('exportCourse');
      this.p.toast(n ? tr('exportedCourse', { n }) : tr('exportedNothing'));
    })));
    const backup = el('button.pbtn', { text: tr('backupMake') });
    backup.addEventListener('click', guard(() => busy(backup, async () => {
      const data = await makeBackup(pdfs.checked);
      const name = 'echo360-lite-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), name);
      this.p.toast(tr('backupMade', { n: Object.keys(data.db).length }));
    })));
    const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    file.addEventListener('change', guard(async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        const n = await restoreBackup(JSON.parse(await f.text()));
        // From now on this page must not write its older data over the restored one (its
        // settings on leaving, the watched record): stop all writes and reload at once.
        storageLock.frozen = true;
        this.p.toast(tr('backupRestored', { n }));
        setTimeout(() => location.reload(), 1200);
      } catch (e) { this.p.toast(tr('exportFailed', { msg: (e && e.message) || e })); }
      file.value = '';
    }));
    const restore = el('button.pbtn', { text: tr('backupRestore'), onclick: () => file.click() });
    return el('div.tagman', null,
      el('div.pinfo', { text: tr('exportInfo') }),
      el('label.crow', null, pics, el('span', { text: hasPdf ? tr('exportPictures') : tr('exportPicturesNoPdf') })),
      el('div.crow', null, one, all),
      el('div.pinfo', { text: tr('backupInfo') }),
      el('label.crow', null, pdfs, el('span', { text: tr('backupPdfs') })),
      el('div.crow', null, backup, restore, file),
      el('div.crow', null, el('span.grow'), el('button.link', { text: tr('done'), onclick: () => { this.exporting = false; this.render(); } })));
  }

  // `G`: tags the note or bookmark at the current time (within the last 30 s, or just
  // ahead), or bookmarks this moment first; opens its tag picker.
  async tagHere(e) {
    const now = this.p.video.currentTime;
    let item = null;
    for (const x of this.items) if (x.type !== 'flag' && x.time != null && x.time <= now + 5 && x.time >= now - 30 && (!item || Math.abs(x.time - now) < Math.abs(item.time - now))) item = x;
    if (!item) {
      // The bookmark just made, and only that one: if adding it failed, nothing is tagged.
      item = await this.addBookmark(e);
      if (!item) return;
    }
    this.filter = 'all';
    this.select.value = 'all';
    this.tagFilter = '';
    this.picking = item.id;
    this.p.sidebar.open('notes');
    this.render();
    // (The page replaces the global CSS object, so no CSS.escape here.)
    const card = [...this.list.querySelectorAll('.card')].find((c) => c.dataset.id === String(item.id));
    if (card) { card.scrollIntoView({ block: 'nearest' }); const b = card.querySelector('.tagopt'); if (b) b.focus(); }
  }

  dispose() {
    this.d.dispose();
  }
}
