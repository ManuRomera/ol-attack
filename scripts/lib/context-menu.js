let _activeMenu = null;
let _cleanupFns = [];

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function closeOlContextMenu() {
  for (const fn of _cleanupFns.splice(0)) {
    try { fn(); } catch (_) {}
  }
  if (_activeMenu?.remove) {
    try { _activeMenu.remove(); } catch (_) {}
  }
  _activeMenu = null;
}

export function openOlContextMenu({ x = 0, y = 0, title = '', items = [] } = {}) {
  closeOlContextMenu();

  const validItems = Array.from(items || []).filter((it) => it && (it.type === 'separator' || it.label));
  if (!validItems.length) return null;

  const root = document.createElement('div');
  root.className = 'ol-context-menu ol-theme-panel';
  root.setAttribute('role', 'menu');
  root.style.position = 'fixed';
  root.style.left = `${Number(x) || 0}px`;
  root.style.top = `${Number(y) || 0}px`;
  root.style.zIndex = '10000';

  if (title) {
    const head = document.createElement('div');
    head.className = 'ol-context-menu-title';
    head.textContent = String(title);
    root.appendChild(head);
  }

  const list = document.createElement('div');
  list.className = 'ol-context-menu-list';
  root.appendChild(list);

  for (const item of validItems) {
    if (item.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'ol-context-menu-separator';
      list.appendChild(sep);
      continue;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ol-context-menu-item${item.danger ? ' danger' : ''}${item.disabled ? ' is-disabled' : ''}`;
    btn.setAttribute('role', 'menuitem');
    btn.disabled = !!item.disabled;
    btn.textContent = String(item.label || '');
    if (item.hint) btn.title = String(item.hint);
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.disabled) return;
      closeOlContextMenu();
      try {
        await item.action?.(ev);
      } catch (err) {
        console.warn('[ol-attack] Error en menú contextual', err);
      }
    });
    list.appendChild(btn);
  }

  document.body.appendChild(root);
  _activeMenu = root;

  const rect = root.getBoundingClientRect();
  const pad = 8;
  const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
  const vh = window.innerHeight || document.documentElement.clientHeight || 720;
  root.style.left = `${_clamp(Number(x) || 0, pad, Math.max(pad, vw - rect.width - pad))}px`;
  root.style.top = `${_clamp(Number(y) || 0, pad, Math.max(pad, vh - rect.height - pad))}px`;

  const onWindowDown = (ev) => {
    if (!_activeMenu) return;
    if (_activeMenu.contains(ev.target)) return;
    closeOlContextMenu();
  };
  const onWindowContext = (ev) => {
    if (!_activeMenu) return;
    if (_activeMenu.contains(ev.target)) return;
    closeOlContextMenu();
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') closeOlContextMenu();
  };
  const onResize = () => closeOlContextMenu();
  const onScroll = () => closeOlContextMenu();

  window.addEventListener('mousedown', onWindowDown, true);
  window.addEventListener('contextmenu', onWindowContext, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize, true);
  window.addEventListener('scroll', onScroll, true);
  _cleanupFns.push(() => window.removeEventListener('mousedown', onWindowDown, true));
  _cleanupFns.push(() => window.removeEventListener('contextmenu', onWindowContext, true));
  _cleanupFns.push(() => window.removeEventListener('keydown', onKey, true));
  _cleanupFns.push(() => window.removeEventListener('resize', onResize, true));
  _cleanupFns.push(() => window.removeEventListener('scroll', onScroll, true));

  root.addEventListener('mousedown', (ev) => ev.stopPropagation());
  root.addEventListener('contextmenu', (ev) => ev.preventDefault());

  const firstEnabled = root.querySelector('.ol-context-menu-item:not(.is-disabled)');
  firstEnabled?.focus?.();
  return root;
}
