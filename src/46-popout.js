// ===================================================================================
// The floating window (Document Picture-in-Picture): the whole player (both views,
// controls, captions, side panel) moves into a small always-on-top window and back.
// Nothing is rebuilt: the same elements, streams and audio graph move.
//
// deps: { host, video, title, $, onKey (keyboard handler, for the window's document),
//         isDestroyed(), relayout() (sizes changed: quality caps, PDF), toast(msg) }
// ===================================================================================

class PopoutController {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.window = null;
    this.opening = false;
    const btn = deps.$('.popbtn');
    btn.hidden = !PopoutController.supported();
    this.d.listen(btn, 'click', () => this.toggle());
    // On teardown: close the window; its pagehide (sync or later) only removes the
    // placeholder, since the player is destroyed by then.
    this.d.add(() => { if (this.window) { try { this.window.close(); } catch (e) { /* closed */ } } });
  }

  static supported() { return typeof window.documentPictureInPicture === 'object' && !!window.documentPictureInPicture; }

  async toggle() {
    if (this.window) { this.window.close(); return; }
    // A second press while the window is being opened does nothing (no second window).
    if (this.opening) return;
    this.opening = true;
    try { await this.open(); } finally { this.opening = false; }
  }

  async open() {
    const x = this.x;
    const host = x.host;
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    const r = host.getBoundingClientRect();
    let pip;
    try {
      pip = await window.documentPictureInPicture.requestWindow({ width: Math.round(Math.min(960, r.width * 0.6)), height: Math.round(Math.min(600, r.height * 0.6)) });
    } catch (e) {
      x.toast(tr('popoutFailed', { msg: (e && e.message) || e }));
      return;
    }
    if (x.isDestroyed()) { pip.close(); return; }
    const playing = !x.video.paused;
    const holder = el('div.e3l-holder', { style: 'display:flex;align-items:center;justify-content:center;gap:12px;width:100%;height:' + Math.round(r.height) + 'px;background:#111;color:#ccc;font:14px system-ui,sans-serif' },
      el('span', { text: tr('popoutHere') }),
      el('button', { text: tr('popoutBack'), style: 'padding:6px 12px;border-radius:8px;border:0;cursor:pointer', onclick: () => pip.close() }));
    const doc = pip.document;
    const css = host.style.cssText;
    const keys = (e) => x.onKey(e);
    const resize = () => { if (!x.isDestroyed()) x.relayout(); };
    // Putting the player back. Registered before anything moves, so a failure half-way
    // (or the window closing at any point) always brings the player back to the page.
    let back = false;
    const putBack = () => {
      if (back) return;
      back = true;
      doc.removeEventListener('keydown', keys, true);
      pip.removeEventListener('resize', resize);
      this.window = null;
      // The player was destroyed meanwhile (handed over to the original player): only the
      // placeholder goes; the old player must not come back over the original one.
      if (x.isDestroyed()) { holder.remove(); return; }
      const still = !x.video.paused;
      host.classList.remove('in-popout');
      host.style.cssText = css;
      if (holder.isConnected) holder.replaceWith(host);
      if (still && x.video.paused) x.video.play().catch(() => {});
      x.$('.popbtn').setAttribute('aria-pressed', 'false');
      x.relayout();
    };
    pip.addEventListener('pagehide', putBack, { once: true });
    this.window = pip;
    try {
      host.replaceWith(holder);
      doc.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
      doc.title = x.title;
      host.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
      doc.body.append(host);
      host.classList.add('in-popout');
      doc.addEventListener('keydown', keys, true);
      pip.addEventListener('resize', resize);
      // Moving can pause the elements in some browsers: carry on as before.
      if (playing && x.video.paused) x.video.play().catch(() => {});
      x.$('.popbtn').setAttribute('aria-pressed', 'true');
    } catch (e) {
      putBack();
      try { pip.close(); } catch (err) { /* already closed */ }
      throw e;
    }
  }
}
