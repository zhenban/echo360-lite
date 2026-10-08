// ===================================================================================
// Small, dismissible notice shown when we fall back to the original player.
// ===================================================================================

function notice(text) {
  const show = () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>div{position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:min(420px,calc(100vw - 32px));'
      + 'padding:10px 12px 10px 14px;border-radius:10px;background:rgba(20,20,24,.94);color:#eee;'
      + 'font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;gap:10px;align-items:flex-start}'
      + 'button{all:unset;cursor:pointer;opacity:.7;padding:0 4px}button:hover{opacity:1}</style>'
      + '<div role="status"><span></span><button>✕</button></div>';
    root.querySelector('span').textContent = text;
    const close = root.querySelector('button');
    close.setAttribute('aria-label', tr('close'));
    close.addEventListener('click', () => host.remove());
    document.body.appendChild(host);
    setTimeout(() => host.remove(), 10000);
  };
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
}
