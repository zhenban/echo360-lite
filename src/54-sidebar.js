// ===================================================================================
// Side panel with tabs (transcript, slides, notes, discussion). Each tab is a controller with
// show(visible); only the active tab of an open panel is visible, so hidden tabs do no work.
// ===================================================================================

// Small DOM helper: h('button.btn.primary', { title: 'x', onclick }, 'text', child, ...)
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

const SIDEBAR_TABS = ['transcript', 'slides', 'notes', 'discussion'];

class Sidebar {
  constructor(player, elem) {
    this.p = player;
    this.el = elem;
    this.controllers = {};
    this.active = null;
    this.isOpen = false;
    this.d = new Disposer();
    for (const b of elem.querySelectorAll('.tabs [data-tab]')) {
      this.d.listen(b, 'click', () => this.switchTo(b.dataset.tab));
    }
  }

  tabButton(tab) { return this.el.querySelector('.tabs [data-tab="' + tab + '"]'); }

  pane(tab) { return this.el.querySelector('.pane[data-pane="' + tab + '"]'); }

  register(tab, controller) {
    this.controllers[tab] = controller;
    this.tabButton(tab).hidden = false;
    for (const chip of this.p.root.querySelectorAll('.top [data-open="' + tab + '"]')) chip.hidden = false;
  }

  has(tab) { return !!this.controllers[tab]; }

  visible(tab) { return this.isOpen && this.active === tab; }

  open(tab) {
    const target = this.has(tab) ? tab : (this.has(this.active) ? this.active : SIDEBAR_TABS.find((x) => this.has(x)));
    if (!target) return;
    this.isOpen = true;
    this.el.hidden = false;
    this.switchTo(target);
    this.p.onSidebarChange();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.hidden = true;
    if (this.active && this.controllers[this.active]) this.controllers[this.active].show(false);
    this.p.onSidebarChange();
  }

  toggle(tab) {
    if (this.isOpen && (!tab || this.active === tab)) this.close();
    else this.open(tab);
  }

  switchTo(tab) {
    if (!this.has(tab)) return;
    const prev = this.active;
    if (prev && prev !== tab && this.controllers[prev]) this.controllers[prev].show(false);
    this.active = tab;
    for (const t2 of SIDEBAR_TABS) {
      const pane = this.pane(t2);
      if (pane) pane.hidden = t2 !== tab;
      const b = this.tabButton(t2);
      if (b) b.setAttribute('aria-selected', String(t2 === tab));
    }
    if (this.isOpen) this.controllers[tab].show(true);
    this.p.onSidebarChange();
  }

  dispose() {
    for (const c of Object.values(this.controllers)) if (c.dispose) c.dispose();
    this.d.dispose();
  }
}
