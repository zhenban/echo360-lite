// ===================================================================================
// Discussion tab: the lesson's public questions and replies.
// Loaded once at start (for availability and progress-bar markers) and again when the tab
// is opened or refreshed, and after every write, so the list always shows server state.
// Every write is a click (or Ctrl+Enter) by the user; the composer states who can see posts.
// ===================================================================================

const MAX_POST_LENGTH = 5000;

class DiscussionPane {
  constructor(player, pane, api) {
    this.p = player;
    this.pane = pane;
    this.api = api;
    this.threads = [];
    this.hiddenCount = 0;
    this.sort = 'newest';
    this.visible = false;
    this.dirty = true;
    this.openReplies = new Set();
    this.replyOpen = null;
    this.loadedAt = 0;
    this.d = new Disposer();
    this.build();
  }

  // Resolves true when discussions are enabled for this lesson.
  // Loads can overlap (after a write, on opening the tab, "Refresh"): only the newest one's
  // answer is used, so an older answer arriving late cannot hide a post just made.
  async load() {
    const seq = (this.loadSeq = (this.loadSeq || 0) + 1);
    try {
      const data = await this.api.discussions();
      if (seq !== this.loadSeq) return true;
      this.threads = data.threads;
      this.hiddenCount = data.hiddenCount;
      this.loadedAt = Date.now();
      this.showError('');
      this.changed();
      return true;
    } catch (e) {
      if (seq !== this.loadSeq) return false;
      log.info('discussions unavailable:', e.message);
      if (this.loadedAt) this.showError(tr('loadFailed', { error: e.message }));
      return false;
    }
  }

  changed() {
    this.dirty = true;
    if (this.visible) this.render();
    this.p.updateMarkers();
  }

  build() {
    this.textarea = el('textarea.input', { rows: 3, maxLength: MAX_POST_LENGTH + 500, placeholder: tr('postPlaceholder'), 'aria-label': tr('postPlaceholder') });
    this.counter = el('span.counter');
    this.linkTime = el('input', { type: 'checkbox', checked: true });
    this.linkLabel = el('span');
    this.anon = el('input', { type: 'checkbox' });
    this.postBtn = el('button.pbtn.primary', { text: tr('postPublic'), onclick: (e) => this.post(e) });
    this.d.listen(this.textarea, 'input', () => this.updateCounter(this.textarea, this.counter, this.postBtn));
    this.d.listen(this.textarea, 'focus', () => this.updateLinkLabel());
    this.d.listen(this.textarea, 'keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.post(e); }
    });
    this.sortSel = el('select.input.small', { 'aria-label': tr('sortNewest') },
      el('option', { value: 'newest', text: tr('sortNewest') }), el('option', { value: 'time', text: tr('sortVideoTime') }));
    this.d.listen(this.sortSel, 'change', () => { this.sort = this.sortSel.value; this.render(); });
    this.hiddenEl = el('span.pmuted');
    this.errorEl = el('div.perror', { hidden: true });
    this.list = el('div.plist');
    this.pane.append(
      el('div.composer.public', null,
        el('div.pwarn', { role: 'note', text: tr('publicWarning') }),
        this.textarea,
        el('div.crow', null,
          el('label.check', null, this.linkTime, this.linkLabel),
          el('label.check', null, this.anon, el('span', { text: tr('hideName') })),
          el('span.grow'), this.counter, this.postBtn)),
      el('div.ptools', null, this.sortSel, this.hiddenEl, el('span.grow'),
        el('button.link', { text: tr('refresh'), onclick: () => this.load() })),
      this.errorEl,
      this.list,
    );
    this.updateLinkLabel();
    this.updateCounter(this.textarea, this.counter, this.postBtn);
  }

  updateLinkLabel() {
    this.linkLabel.textContent = tr('linkTime', { time: fmtTime(this.p.video.currentTime, this.p.duration() >= 3600) });
  }

  updateCounter(area, counter, button) {
    const left = MAX_POST_LENGTH - area.value.length;
    counter.textContent = left < 0 ? tr('tooLong', { n: -left }) : left < 500 ? tr('charsLeft', { n: left }) : '';
    counter.classList.toggle('over', left < 0);
    button.disabled = left < 0 || !area.value.trim();
  }

  show(on) {
    this.visible = on;
    if (!on) return;
    this.updateLinkLabel();
    if (this.dirty) this.render();
    // Refresh when the tab is opened, at most once a minute (no live push channel).
    if (Date.now() - this.loadedAt > 60000) this.load();
  }

  showError(msg) {
    this.errorEl.textContent = msg;
    this.errorEl.hidden = !msg;
  }

  fail(e) {
    log.warn('discussion write failed', e);
    this.showError(tr('saveFailed', { error: e.message || e }));
  }

  sorted() {
    const list = this.threads.slice();
    if (this.sort === 'time') list.sort((a, b) => (a.time == null ? Infinity : a.time) - (b.time == null ? Infinity : b.time));
    else list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return list;
  }

  render() {
    this.dirty = false;
    this.hiddenEl.textContent = this.hiddenCount ? tr('hiddenPosts', { n: this.hiddenCount }) : '';
    const long = this.p.duration() >= 3600;
    const frag = document.createDocumentFragment();
    if (!this.threads.length) frag.append(el('div.pempty', { text: tr('noPosts') }));
    for (const q of this.sorted()) frag.append(this.renderThread(q, long));
    this.list.textContent = '';
    this.list.append(frag);
  }

  renderThread(q, long) {
    const card = el('div.card.thread', null, this.renderComment(q, long));
    const n = q.replies.length;
    const footer = el('div.iactions');
    if (n) {
      const open = this.openReplies.has(q.id);
      footer.append(el('button.link', {
        text: open ? tr('hideReplies') : (n === 1 ? tr('oneReply') : tr('replies', { n })),
        onclick: () => { if (open) this.openReplies.delete(q.id); else this.openReplies.add(q.id); this.render(); },
      }));
    }
    footer.append(el('button.link', { text: tr('replyPublic'), onclick: () => { this.replyOpen = q.id; this.openReplies.add(q.id); this.render(); } }));
    card.append(footer);
    if (n && this.openReplies.has(q.id)) {
      const replies = el('div.replies');
      for (const r of q.replies) replies.append(this.renderComment(r, long));
      card.append(replies);
    }
    if (this.replyOpen === q.id) card.append(this.renderReplyComposer(q));
    return card;
  }

  renderComment(c, long) {
    const who = c.mine ? tr('you') + (c.nameHidden ? ' (' + tr('anonymous') + ')' : '') : (c.author || tr('anonymous'));
    const badges = [];
    if (c.instructor) badges.push(el('span.badge.inst', { text: tr('instructor') }));
    if (c.ta) badges.push(el('span.badge.inst', { text: tr('ta') }));
    const time = c.time != null ? el('button.chiptime', { text: fmtTime(c.time, long), onclick: () => this.p.seek(c.time) }) : null;
    const date = el('span.pmuted', { text: formatDate(c.createdAt), title: c.createdAt || '' });
    const actions = el('div.cactions',
      null,
      el('button.link' + (c.liked ? '.on' : ''), {
        text: (c.liked ? tr('unlike') : tr('like')) + (c.likes ? ' · ' + c.likes : ''),
        onclick: (e) => this.write(e, () => this.api.like(e, c, !c.liked)),
      }),
      c.questionId ? null : el('button.link' + (c.saved ? '.on' : ''), {
        text: c.saved ? tr('unsavePost') : tr('savePost'),
        onclick: (e) => this.write(e, () => this.api.save(e, c, !c.saved)),
      }),
      c.mine ? this.deleteButton(c) : null,
      c.hasAttachment ? el('button.link', { text: tr('attachment') + ' → ' + tr('openInOriginal'), onclick: () => this.p.opts.onFallback('attachment') }) : null,
    );
    return el('div.comment' + (c.questionId ? '.reply' : ''), null,
      el('div.ihead', null, el('span.author', { text: who }), ...badges, time, el('span.grow'), date),
      el('div.ibody', { text: c.body }),
      actions);
  }

  deleteButton(c) {
    let armed = 0;
    const b = el('button.link.danger', { text: tr('delete') });
    b.addEventListener('click', guard((e) => {
      if (!armed) {
        b.textContent = tr('confirmDelete');
        armed = setTimeout(() => { armed = 0; b.textContent = tr('delete'); }, 3000);
        return;
      }
      clearTimeout(armed);
      armed = 0;
      this.write(e, () => this.api.deleteComment(e, c));
    }));
    return b;
  }

  renderReplyComposer(q) {
    const area = el('textarea.input', { rows: 2, placeholder: tr('replyPlaceholder'), 'aria-label': tr('replyPlaceholder') });
    const counter = el('span.counter');
    const anon = el('input', { type: 'checkbox' });
    const send = el('button.pbtn.primary', { text: tr('replyPublic') });
    const submit = (e) => {
      const body = area.value.trim();
      if (this.busy || !body || body.length > MAX_POST_LENGTH) return;
      send.disabled = true;
      this.write(e, () => this.api.reply(e, q.id, { body, anonymous: anon.checked }), () => { this.replyOpen = null; });
    };
    area.addEventListener('input', guard(() => this.updateCounter(area, counter, send)));
    area.addEventListener('keydown', guard((e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(e); } }));
    send.addEventListener('click', guard(submit));
    this.updateCounter(area, counter, send);
    setTimeout(() => area.focus(), 0);
    return el('div.composer.public.reply', null,
      el('div.pwarn', { role: 'note', text: tr('publicWarning') }),
      area,
      el('div.crow', null, el('label.check', null, anon, el('span', { text: tr('hideName') })), el('span.grow'), counter,
        el('button.pbtn', { text: tr('cancel'), onclick: () => { this.replyOpen = null; this.render(); } }), send));
  }

  async post(e) {
    const body = this.textarea.value.trim();
    if (this.busy || !body || body.length > MAX_POST_LENGTH) return;
    this.postBtn.disabled = true;
    const time = this.linkTime.checked ? this.p.video.currentTime : null;
    await this.write(e, () => this.api.postComment(e, { body, anonymous: this.anon.checked, time }), () => {
      this.textarea.value = '';
      this.anon.checked = false;
    });
    this.updateCounter(this.textarea, this.counter, this.postBtn);
  }

  // Runs one write, then reloads the list so it shows what the server stored. One write
  // at a time for the whole tab: a second Ctrl+Enter (or a click while the first request
  // is on its way) does nothing, whatever state the buttons are in, so a post can never
  // be published twice.
  async write(e, fn, onSuccess) {
    if (this.busy) return false;
    this.busy = true;
    let ok = false;
    try {
      await fn();
      ok = true;
      if (onSuccess) onSuccess();
      this.showError('');
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy = false;
    }
    await this.load();
    return ok;
  }

  markers() {
    return this.threads.filter((q) => q.time != null).map((q) => ({
      time: q.time,
      kind: 'comment',
      label: tr('markerComment') + ': ' + (q.body.length > 80 ? q.body.slice(0, 77) + '…' : q.body),
    }));
  }

  dispose() {
    this.d.dispose();
  }
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  try {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch (e) {
    return iso.slice(0, 10);
  }
}
