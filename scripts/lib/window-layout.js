import { MODULE_ID, SETTING_WINDOW_LAYOUT_STATE } from "../shared/constants.js";

const SAVE_DELAY_MS = 180;
const timers = new WeakMap();

let registered = false;

function toFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getStore() {
  try {
    const raw = game.settings.get(MODULE_ID, SETTING_WINDOW_LAYOUT_STATE) || {};
    return {
      windows: raw.windows && typeof raw.windows === "object" ? foundry.utils.deepClone(raw.windows) : {}
    };
  } catch (_) {
    return { windows: {} };
  }
}

async function saveStore(store) {
  try {
    await game.settings.set(MODULE_ID, SETTING_WINDOW_LAYOUT_STATE, store);
  } catch (_) {}
}

function slug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function hasOlContent(html) {
  try {
    const root = html?.jquery ? html : $(html);
    return root.find(".ol-root, .ol-vis-root, .ol-attack, .ol-window-theme, [class*='ol-']").length > 0;
  } catch (_) {
    return false;
  }
}

function getLayoutKey(app, html = null) {
  const options = app?.options || {};
  const id = String(options.id || app?.id || "").trim();
  const classes = Array.isArray(options.classes) ? options.classes.map(String) : [];
  const title = String(app?.title || options.title || "").trim();
  const moduleClass = classes.some((cls) => cls === "ol-attack" || cls === "ol-window-theme" || cls.startsWith("ol-"));
  const moduleId = id.startsWith("ol-") || id.startsWith(`${MODULE_ID}-`) || id === MODULE_ID;
  const moduleTitle = /^ol\b/i.test(title) || /ol attack/i.test(title);

  if (!moduleClass && !moduleId && !moduleTitle && !hasOlContent(html)) return null;
  if (id && id !== "dialog") return id;

  const titleKey = slug(title);
  return titleKey ? `dialog-${titleKey}` : null;
}

function readPosition(app) {
  const pos = app?.position || {};
  return {
    left: toFinite(pos.left),
    top: toFinite(pos.top),
    width: toFinite(pos.width),
    height: toFinite(pos.height)
  };
}

function hasAnyPositionValue(pos) {
  return ["left", "top", "width", "height"].some((key) => Number.isFinite(Number(pos?.[key])));
}

async function persist(app, key) {
  if (!app || !key) return;
  const current = readPosition(app);
  if (!hasAnyPositionValue(current)) return;

  const store = getStore();
  store.windows[key] = {
    ...(store.windows[key] || {}),
    ...current,
    updatedAt: Date.now()
  };
  await saveStore(store);
}

function schedulePersist(app, key) {
  if (!app || !key) return;
  clearTimeout(timers.get(app));
  timers.set(app, setTimeout(() => persist(app, key), SAVE_DELAY_MS));
}

function restore(app, key) {
  if (!app || !key) return;
  const saved = getStore().windows?.[key];
  if (!saved || !hasAnyPositionValue(saved)) return;

  const position = {};
  for (const field of ["left", "top", "width", "height"]) {
    const value = toFinite(saved[field]);
    if (value !== null) position[field] = value;
  }

  try {
    app.setPosition(position);
  } catch (_) {}
}

function wrapSetPosition(app, key) {
  if (!app || !key || app._olWindowLayoutWrapped) return;
  const original = app.setPosition?.bind(app);
  if (typeof original !== "function") return;

  app._olWindowLayoutWrapped = true;
  app.setPosition = (position = {}) => {
    const out = original(position);
    schedulePersist(app, key);
    return out;
  };
}

export function registerWindowLayoutPersistence() {
  if (registered) return;
  registered = true;

  Hooks.on("renderApplication", (app, html) => {
    const key = getLayoutKey(app, html);
    if (!key) return;

    app._olWindowLayoutKey = key;
    wrapSetPosition(app, key);

    if (!app._olWindowLayoutRestored) {
      app._olWindowLayoutRestored = true;
      restore(app, key);
    } else {
      schedulePersist(app, key);
    }
  });

  Hooks.on("closeApplication", (app) => {
    const key = app?._olWindowLayoutKey || getLayoutKey(app);
    if (!key) return;
    clearTimeout(timers.get(app));
    persist(app, key);
  });
}
