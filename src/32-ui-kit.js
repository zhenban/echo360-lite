// ===================================================================================
// Shared UI components (docs/DESIGN.md "Components"). Every menu and popup of the player
// is made from these; no part positions, opens or closes one by itself.
//
//   Popovers      one popover open at a time, anchored to the button that opened it
//                 (above for the control bar, below for the title bar), moved inward at
//                 the edges, a bottom sheet when the player is phone-narrow; closes on
//                 Esc and on a press outside, and gives the focus back to its button.
//   SettingsMenu  a menu of items with second-level pages and a back button.
//   Tooltips      a label above or below a control, for a mouse or keyboard only; the
//                 same text is always the control's accessible name or in a menu too.
//   setPressed, setUnavailable, unavailableReason   on/off and "not now (why)" states
//                 of buttons (drawn by the stylesheet, not by colour alone).
// ===================================================================================

function setPressed(btn, on) {
  btn.setAttribute('aria-pressed', String(!!on));
}

// A control that cannot be used now: dimmed; its tooltip says why, and so does a press
// (a touch screen has no tooltips). reason '' makes it usable again with its tooltip `tip`.
function setUnavailable(btn, reason, tip) {
  btn.setAttribute('aria-disabled', String(!!reason));
  btn.dataset.reason = reason || '';
  btn.dataset.tip = reason || tip;
}

// An inline SVG icon in a span (el() sets only text).
function iconEl(name, cls) {
  const s = el('span' + (cls ? '.' + cls : ''));
  s.innerHTML = svg(name);
  return s;
}

function unavailableReason(btn) {
  return btn.getAttribute('aria-disabled') === 'true' ? btn.dataset.reason || '' : '';
}

class Popovers {
  // box: where popovers are placed (covers the whole player); onChange(open) after each
  // open and close.
  constructor(box, disposer, onChange) {
    this.box = box;
    this.d = disposer;
    this.cur = null;   // { pop, anchor, placement, onClose }
    this.pointerAt = 0;   // time of the last press (a popover opened by one does not focus an item)
    this.onChange = onChange || (() => {});
    // A press outside the open popover and its button closes it (the button's own click
    // toggles it).
    disposer.listen(box.getRootNode(), 'pointerdown', (e) => {
      this.pointerAt = performance.now();
      const c = this.cur;
      if (!c) return;
      const path = e.composedPath();
      if (path.includes(c.pop.el) || (c.anchor.nodeType && path.includes(c.anchor))) return;
      this.close(false);
    }, true);
    disposer.listen(windowOf(box), 'resize', () => this.place());
    disposer.add(() => this.close(false));
  }

  // A popover element (filled by the caller). role: 'menu' (arrow keys move between its
  // items) or 'dialog'.
  create(cls, role, label) {
    const elem = el('div.pop.' + cls, { role, 'aria-label': label, tabindex: '-1', hidden: true });
    this.box.append(elem);
    const pop = { el: elem, role };
    this.d.listen(elem, 'keydown', (e) => this.onKey(e, pop));
    // Focus moving elsewhere by keyboard (Tab) closes it.
    this.d.listen(elem, 'focusout', (e) => {
      if (this.isOpen(pop) && e.relatedTarget && !elem.contains(e.relatedTarget) && e.relatedTarget !== this.cur.anchor) this.close(false);
    });
    return pop;
  }

  isOpen(pop) {
    return pop ? !!this.cur && this.cur.pop === pop : !!this.cur;
  }

  // anchor: the button (or { getBoundingClientRect } for a point, e.g. a right-click).
  open(pop, anchor, placement, onClose) {
    if (this.cur) this.close(false);
    this.cur = { pop, anchor, placement, onClose };
    if (anchor.nodeType) anchor.setAttribute('aria-expanded', 'true');
    const elem = pop.el;
    elem.hidden = false;
    elem.classList.add('entering');
    this.place();
    void elem.offsetWidth;   // start the opening transition from the entering state
    elem.classList.remove('entering');
    this.focusFirst();
    this.onChange(true);
  }

  toggle(pop, anchor, placement, onClose) {
    if (this.isOpen(pop)) this.close(true); else this.open(pop, anchor, placement, onClose);
  }

  close(focusBack) {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    c.pop.el.hidden = true;
    if (c.anchor.nodeType) {
      c.anchor.setAttribute('aria-expanded', 'false');
      if (focusBack) c.anchor.focus({ preventScroll: true });
    }
    if (c.onClose) c.onClose();
    this.onChange(false);
  }

  // Opened from the keyboard: the first item takes the focus (arrow keys go on from there).
  // Opened by a press: the popover itself does, so no item looks selected.
  focusFirst() {
    const c = this.cur;
    if (!c) return;
    if (performance.now() - this.pointerAt < 1000) { c.pop.el.focus({ preventScroll: true }); return; }
    const first = c.pop.el.querySelector('[data-autofocus], .mi:not([aria-disabled=true]), button, [tabindex="0"]');
    (first || c.pop.el).focus({ preventScroll: true });
  }

  // Positions the open popover; again after its content or the window changes.
  place() {
    const c = this.cur;
    if (!c) return;
    const elem = c.pop.el;
    const box = this.box.getBoundingClientRect();
    const sheet = box.width < SHEET_BELOW;
    elem.classList.toggle('sheet', sheet);
    elem.style.maxHeight = '';
    if (sheet) return;
    const a = c.anchor.getBoundingClientRect();
    const room = { above: a.top - box.top - POP_GAP - POP_MARGIN, below: box.bottom - a.bottom - POP_GAP - POP_MARGIN };
    const want = elem.offsetHeight;
    // The asked side, unless it is too short and the other side has more room.
    let side = c.placement;
    const other = side === 'above' ? 'below' : 'above';
    if (room[side] < want && room[other] > room[side]) side = other;
    elem.style.maxHeight = Math.max(80, room[side]) + 'px';
    const w = elem.offsetWidth;
    const h = elem.offsetHeight;
    const left = clamp(a.left + a.width / 2 - w / 2 - box.left, POP_MARGIN, Math.max(POP_MARGIN, box.width - w - POP_MARGIN));
    const top = side === 'above' ? a.top - box.top - POP_GAP - h : a.bottom - box.top + POP_GAP;
    elem.style.left = Math.round(left) + 'px';
    elem.style.top = Math.round(Math.max(POP_MARGIN, top)) + 'px';
    elem.style.setProperty('--from', side === 'above' ? '4px' : '-4px');
  }

  onKey(e, pop) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
      return;
    }
    if (pop.role !== 'menu' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = [...pop.el.querySelectorAll('.mi, .mhead .btn')].filter((x) => x.getAttribute('aria-disabled') !== 'true');
    if (!items.length) return;
    const i = items.indexOf(e.composedPath()[0]);   // -1 (the popover itself): Down goes to the first
    const n = items.length;
    const next = e.key === 'Home' ? 0 : e.key === 'End' || (i < 0 && e.key === 'ArrowUp') ? n - 1 : e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
    items[next].focus();
    e.preventDefault();
  }
}

// A menu whose items may open second-level pages (with a back button), like a video
// player's settings menu. Items are described, not built, so the menu always shows the
// current state (refresh() redraws the page shown). Item kinds:
//   { kind: 'page', label, value() (shown on the right), items() }
//   { kind: 'action', label, key, run(event), reason() ('' or why not now), stay }
//   { kind: 'toggle', label, desc, on(), set(on, event), reason() }
//   { kind: 'radio', label, checked(), select() }
//   { kind: 'text', text(), warn } | { kind: 'group', label } | { kind: 'sep' }
//   { kind: 'custom', render() -> element } | { kind: 'foot', text }
// Any item may have hidden() -> true to leave it out.
class SettingsMenu {
  constructor(pops, cls, label, root, disposer) {
    this.pops = pops;
    this.root = root;
    this.pop = pops.create(cls, 'menu', label);
    this.stack = [];
    this.shown = [];
    this.anchor = null;
    disposer.listen(this.pop.el, 'click', (e) => {
      const b = e.target.closest('[data-i], .mback');
      if (!b) return;
      e.stopPropagation();
      if (b.classList.contains('mback')) { this.back(); return; }
      this.activate(this.shown[+b.dataset.i], e);
    });
    disposer.listen(this.pop.el, 'keydown', (e) => {
      const t = e.composedPath()[0];
      if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && this.stack.length) { e.preventDefault(); this.back(); }
      if (e.key === 'ArrowRight' && t.dataset && t.dataset.i != null && this.shown[+t.dataset.i].kind === 'page') {
        e.preventDefault();
        this.activate(this.shown[+t.dataset.i], e);
      }
    });
  }

  get isOpen() { return this.pops.isOpen(this.pop); }

  open(anchor, placement) {
    this.stack = [];
    this.anchor = anchor;
    this.render();
    this.pops.open(this.pop, anchor, placement, () => { this.stack = []; });
  }

  toggle(anchor, placement) {
    if (this.isOpen) this.pops.close(true); else this.open(anchor, placement);
  }

  close(focusBack) {
    if (this.isOpen) this.pops.close(focusBack);
  }

  refresh() {
    if (!this.isOpen) return;
    const active = this.pop.el.getRootNode().activeElement;
    const at = active && active.dataset ? active.dataset.i : null;
    this.render();
    if (at != null) {
      const again = this.pop.el.querySelector('[data-i="' + at + '"]');
      if (again) again.focus({ preventScroll: true });
    }
    this.pops.place();
  }

  back() {
    this.stack.pop();
    this.render();
    this.pops.place();
    this.pops.focusFirst();
  }

  activate(item, e) {
    if (!item) return;
    if (item.kind === 'page') {
      this.stack.push(item);
      this.render();
      this.pops.place();
      this.pops.focusFirst();
    } else if (item.kind === 'action') {
      if (item.reason && item.reason()) return;
      if (!item.stay) this.pops.close(false);
      item.run(e);
      if (item.stay) this.refresh();
    } else if (item.kind === 'toggle') {
      if (item.reason && item.reason()) return;
      item.set(!item.on(), e);
      this.refresh();
    } else if (item.kind === 'radio') {
      item.select();
      this.refresh();
    }
  }

  render() {
    const page = this.stack[this.stack.length - 1];
    const items = (page ? page.items() : this.root()).filter((it) => it && !(it.hidden && it.hidden()));
    const body = this.pop.el;
    body.textContent = '';
    this.shown = items;
    if (page) {
      const back = el('button.btn.mback', { 'aria-label': tr('menuBack') });
      back.innerHTML = svg('back');
      body.append(el('div.mhead', null, back, el('span', { text: page.label })));
    }
    items.forEach((it, i) => body.append(this.item(it, i)));
  }

  item(it, i) {
    const reason = it.reason ? it.reason() : '';
    const btn = (role, ...kids) => el('button.mi', { role, 'data-i': String(i), 'aria-disabled': reason ? 'true' : null }, ...kids);
    const label = (desc) => el('span.lbl', { text: it.label }, desc ? el('span.desc', { text: desc }) : null);
    switch (it.kind) {
      case 'page': {
        const b = btn('menuitem', label(), el('span.val', { text: it.value ? it.value() : '' }), iconEl('next'));
        b.setAttribute('aria-haspopup', 'menu');
        return b;
      }
      case 'action':
        return btn('menuitem', label(reason), it.key ? el('span.key', { text: it.key }) : null);
      case 'toggle': {
        const b = btn('menuitemcheckbox', label(reason || it.desc), el('span.sw'));
        b.setAttribute('aria-checked', String(!reason && !!it.on()));
        return b;
      }
      case 'radio': {
        const b = btn('menuitemradio', iconEl('check', 'tick'), label());
        b.setAttribute('aria-checked', String(!!it.checked()));
        return b;
      }
      case 'text': return el('div.mtext' + (it.warn ? '.warn' : ''), { text: it.text() });
      case 'group': return el('div.mgroup', { text: it.label });
      case 'sep': return el('div.msep', { role: 'separator' });
      case 'foot': return el('div.mfoot', { text: it.text });
      default: return it.render();
    }
  }
}

class Tooltips {
  // scope: where the controls are (the shadow root); box: where the tooltip is placed.
  constructor(scope, box, disposer) {
    this.box = box;
    this.tip = el('div.tooltip', { role: 'tooltip', hidden: true });
    box.append(this.tip);
    this.target = null;
    this.timer = 0;
    disposer.add(() => clearTimeout(this.timer));
    disposer.listen(scope, 'pointerover', (e) => {
      if (e.pointerType !== 'mouse') return;
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t || t === this.target) return;
      // Moving from one control to the next shows the next label at once.
      const warm = !this.tip.hidden;
      this.hide();
      this.target = t;
      if (warm) this.show(); else this.timer = setTimeout(guard(() => this.show()), TIP_DELAY_MS);
    });
    disposer.listen(scope, 'pointerout', (e) => {
      if (this.target && !(e.relatedTarget && this.target.contains(e.relatedTarget))) { this.hide(); this.target = null; }
    });
    disposer.listen(scope, 'pointerdown', () => { this.hide(); this.target = null; }, true);
    // Tooltips are a desktop aid: on touch devices (no hover) the focus path stays quiet too.
    disposer.listen(scope, 'focusin', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (t && t.matches(':focus-visible') && windowOf(box).matchMedia('(hover: hover)').matches) { this.hide(); this.target = t; this.show(); }
    });
    disposer.listen(scope, 'focusout', () => { this.hide(); this.target = null; });
  }

  show() {
    const t = this.target;
    const text = t && t.isConnected ? t.dataset.tip : '';
    if (!text || t.closest('.idle .top, .idle .bottom, .pop')) return;
    const tip = this.tip;
    tip.textContent = text;
    tip.hidden = false;
    const box = this.box.getBoundingClientRect();
    const a = t.getBoundingClientRect();
    // Below the controls in the top half of the player, above the others.
    const below = a.top - box.top < box.height / 2;
    const left = clamp(a.left + a.width / 2 - tip.offsetWidth / 2 - box.left, POP_MARGIN, box.width - tip.offsetWidth - POP_MARGIN);
    const top = below ? a.bottom - box.top + 6 : a.top - box.top - 6 - tip.offsetHeight;
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
  }

  hide() {
    clearTimeout(this.timer);
    this.tip.hidden = true;
  }
}
