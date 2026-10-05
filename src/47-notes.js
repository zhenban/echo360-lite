// ===================================================================================
// Notes tab: private notes, bookmarks and "didn't understand" flags, sorted by time.
// Data is loaded once at start (it also feeds the progress-bar markers); the list DOM is
// only rebuilt while the tab is visible.
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
    this.visible = false;
    this.dirty = true;
    this.d = new Disposer();
    this.build();
  }

  // Resolves true when notes are available for this recording.
  async load() {
    const [notes, flags] = await Promise.allSettled([this.api.notes(), this.canFlag ? this.api.flags() : Promise.resolve([])]);
    if (notes.status !== 'fulfilled') {
      console.info(TAG, 'notes unavailable:', notes.reason && notes.reason.message);
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
    const timeLabel = h('span');
    this.composerTime = timeLabel;
    this.textarea = h('textarea.input', { rows: 3, maxLength: 5000, 'aria-label': t('addNote') });
    this.addBtn = h('button.pbtn.primary', { text: t('addNote'), onclick: (e) => this.addNote(e) });
    this.d.listen(this.textarea, 'keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.addNote(e); }
    });
    this.d.listen(this.textarea, 'focus', () => this.updatePlaceholder());
    this.select = h('select.input.small', { 'aria-label': t('filterAll') });
    for (const f of NOTE_FILTERS) {
      const label = { all: t('filterAll'), note: t('filterNotes'), bookmark: t('filterBookmarks'), flag: t('filterFlags') }[f];
      if (f === 'flag' && !this.canFlag) continue;
      this.select.append(h('option', { value: f, text: label }));
    }
    this.d.listen(this.select, 'change', () => { this.filter = this.select.value; this.render(); });
    this.errorEl = h('div.perror', { hidden: true });
    this.list = h('div.plist');
    this.pane.append(
      h('div.pinfo', { text: t('notesPrivate') }),
      h('div.composer', null, this.textarea, h('div.crow', null, timeLabel, h('span.grow'), this.addBtn)),
      h('div.ptools', null, this.select),
      this.errorEl,
      this.list,
    );
  }

  updatePlaceholder() {
    const at = fmtTime(this.p.video.currentTime, this.p.duration() >= 3600);
    this.textarea.placeholder = t('addNotePlaceholder', { time: at });
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
    console.warn(TAG, 'write failed', e);
    this.showError(t('saveFailed', { error: e.message || e }));
    this.p.toast(t('saveFailed', { error: e.message || e }));
  }

  render() {
    this.dirty = false;
    const long = this.p.duration() >= 3600;
    const shown = this.items.filter((x) => this.filter === 'all' || x.type === this.filter);
    const frag = document.createDocumentFragment();
    if (!shown.length) frag.append(h('div.pempty', { text: t('noNotes') }));
    for (const item of shown) frag.append(this.renderItem(item, long));
    this.list.textContent = '';
    this.list.append(frag);
  }

  renderItem(item, long) {
    const label = { note: t('markerNote'), bookmark: t('markerBookmark'), flag: t('markerFlag') }[item.type];
    const time = item.time != null
      ? h('button.chiptime', { text: fmtTime(item.time, long), title: label, onclick: () => this.p.seek(item.time) })
      : null;
    const head = h('div.ihead', null, h('span.kind.k-' + item.type, { text: label }), time, h('span.grow'));
    const body = item.type === 'note' ? h('div.ibody', { text: item.text }) : null;
    const actions = h('div.iactions');
    if (item.type === 'note') actions.append(h('button.link', { text: t('edit'), onclick: () => this.startEdit(item, card) }));
    actions.append(this.deleteButton(item));
    const card = h('div.card.k-' + item.type, null, head, body, actions);
    return card;
  }

  // Two clicks within 3 s delete; the second click is the user action sent with the write.
  deleteButton(item) {
    const label = item.type === 'flag' ? t('remove') : t('delete');
    let armed = 0;
    const b = h('button.link.danger', { text: label });
    b.addEventListener('click', guard((e) => {
      if (!armed) {
        b.textContent = t('confirmDelete');
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
    const area = h('textarea.input', { rows: 3, maxLength: 5000 });
    area.value = item.text;
    const save = h('button.pbtn.primary', { text: t('save') });
    const cancel = h('button.pbtn', { text: t('cancel'), onclick: () => this.render() });
    save.addEventListener('click', guard(async (e) => {
      const text = area.value.trim();
      if (!text) return;
      save.disabled = true;
      try {
        await this.api.updateNote(e, item, text);
        item.text = text;
        this.showError('');
        this.changed();
      } catch (err) { save.disabled = false; this.fail(err); }
    }));
    card.querySelector('.ibody').replaceWith(h('div.composer', null, area, h('div.crow', null, h('span.grow'), cancel, save)));
    card.querySelector('.iactions').hidden = true;
    area.focus();
  }

  async addNote(e) {
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

  async addBookmark(e) {
    const time = this.p.video.currentTime;
    try {
      const note = await this.api.addNote(e, { bookmark: true, time, num: this.count('bookmark') + 1 });
      this.items.push(note);
      this.sort();
      this.changed();
      this.p.toast(t('bookmarkedAt', { time: fmtTime(time) }), t('undo'), (ev) => this.remove(ev, note));
    } catch (err) { this.fail(err); }
  }

  flagAt(time) {
    const scene = Math.floor(time / FLAG_SCENE_SECONDS) * FLAG_SCENE_SECONDS;
    return this.items.find((x) => x.type === 'flag' && x.time === scene) || null;
  }

  async toggleFlag(e) {
    if (!this.canFlag) return;
    const time = this.p.video.currentTime;
    const existing = this.flagAt(time);
    try {
      if (existing) {
        await this.api.removeFlag(e, existing);
        this.items = this.items.filter((x) => x !== existing);
        this.p.toast(t('flagRemoved', { time: fmtTime(existing.time) }));
      } else {
        await this.api.addFlag(e, time);
        const scene = Math.floor(time / FLAG_SCENE_SECONDS) * FLAG_SCENE_SECONDS;
        this.items.push({ id: 'flag-' + scene / FLAG_SCENE_SECONDS, type: 'flag', time: scene, createdAt: new Date().toISOString() });
        this.sort();
        this.p.toast(t('flagAdded', { time: fmtTime(scene) }));
      }
      this.changed();
      this.p.renderFlagButton();
    } catch (err) { this.fail(err); }
  }

  async remove(e, item) {
    try {
      if (item.type === 'flag') await this.api.removeFlag(e, item);
      else await this.api.deleteNote(e, item);
      this.items = this.items.filter((x) => x !== item);
      this.showError('');
      this.changed();
      this.p.renderFlagButton();
    } catch (err) { this.fail(err); }
  }

  markers() {
    return this.items.filter((x) => x.time != null).map((x) => ({
      time: x.time,
      kind: x.type,
      label: x.type === 'note' ? t('markerNote') + ': ' + x.text : x.type === 'bookmark' ? t('markerBookmark') : t('markerFlag'),
    }));
  }

  dispose() {
    this.d.dispose();
  }
}
