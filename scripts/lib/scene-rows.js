/**
 * Filas de los monitores de escena (GM y jugador). Antes cada monitor llevaba su propia copia de
 * estos ayudantes, con diferencias sutiles; ahora hay una sola definición y las diferencias
 * (qué ve cada rol) se resuelven con parámetros.
 */
import { FLAG_CONCENTRATION } from "../shared/constants.js";
import { gp, safeNum } from "./utils.js";
import { leerFlag } from "./flags.js";
import { getItemUses } from "./uses.js";
import { getAvailableSpellSlots } from "./spells.js";
import { getActorHpData, getActorDeathSaveData, getActorTraits } from "../shared/system-data.js";

const t = (key, data) => game.i18n.format(key, data ?? {});

export const norm = (value) => String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const defaultVisualSettings = () => ({ usePortraitBackground: true, backgroundOpacity: 40, overlayOpacity: 60, backgroundSize: "cover" });
export const defaultPlayerViewConfig = () => ({ showPCs: true, showNPCs: true, showHP: true, showTempHP: true, showResources: false, showStatuses: true, showQuickTraits: true, showWeaknesses: false });

export const sortTokensByName = (tokens = []) =>
  Array.from(tokens).sort((a, b) => String(a?.name || a?.actor?.name || "").localeCompare(String(b?.name || b?.actor?.name || ""), game.i18n.lang));

export function isOwnedByCurrentUser(actor) {
  try { return !!actor?.testUserPermission?.(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER); } catch (_) {}
  try { return !!actor?.isOwner; } catch (_) {}
  return false;
}

// ---------- PG ----------
function mixHex(a, b, k) {
  const pa = a.replace("#", ""), pb = b.replace("#", "");
  const c = (p, i) => parseInt(p.slice(i, i + 2), 16);
  const lerp = (x, y) => Math.round(x + (y - x) * k);
  return `rgb(${lerp(c(pa, 0), c(pb, 0))}, ${lerp(c(pa, 2), c(pb, 2))}, ${lerp(c(pa, 4), c(pb, 4))})`;
}

export function hpColorByRatio(ratio) {
  const r = clamp(Number(ratio) || 0, 0, 1);
  if (r >= 0.5) return mixHex("#d97706", "#1f9d55", (r - 0.5) / 0.5);
  if (r >= 0.25) return mixHex("#b91c1c", "#d97706", (r - 0.25) / 0.25);
  return mixHex("#050505", "#b91c1c", r / 0.25);
}

export function hpDisplay(hp = {}) {
  const value = Math.max(0, safeNum(hp.value, 0));
  const max = Math.max(0, safeNum(hp.max, 0));
  const temp = Math.max(0, safeNum(hp.temp, 0));
  const tempmax = Math.max(0, safeNum(hp.tempmax, 0));
  const ratio = max > 0 ? clamp(value / max, 0, 1) : 0;
  return {
    value, max, temp, tempmax, ratio,
    pct: Math.round(ratio * 100),
    fillStyle: `width:${Math.round(ratio * 1000) / 10}%; background:${hpColorByRatio(ratio)};`,
    tempFillStyle: temp > 0 ? "width:100%; background:rgba(31,157,85,.9);" : "width:0%; background:transparent;",
    tempActive: temp > 0
  };
}

export function deathSaveDisplay(actor, hp = {}, { player = false } = {}) {
  const death = getActorDeathSaveData(actor);
  const successes = clamp(safeNum(death.success, 0), 0, 3);
  const failures = clamp(safeNum(death.failure, 0), 0, 3);
  const value = safeNum(hp.value, 0);
  const max = safeNum(hp.max, 0);
  const visible = player ? (max > 0 && value <= 0) : (value <= 0 || successes > 0 || failures > 0);
  const state = value > 0 ? "stable" : failures >= 3 ? "dead" : successes >= 3 ? "stable" : "dying";
  return {
    visible, successes, failures,
    successDots: Array.from({ length: 3 }, (_, i) => ({ filled: i < successes, idx: i + 1 })),
    failureDots: Array.from({ length: 3 }, (_, i) => ({ filled: i < failures, idx: i + 1 })),
    stateLabel: t(`OLATTACK.Scene.Death.${state}`)
  };
}

// ---------- Recursos, estados y rasgos rápidos ----------
function resourcePriority(item) {
  const hay = `${norm(item?.name)} ${norm(gp(item, "system.identifier") || "")}`.trim();
  const hit = (...parts) => parts.some((p) => hay.includes(norm(p)));
  if (hit("rage", "furia", "rabia")) return 10;
  if (hit("frenzy", "frenesi")) return 15;
  if (hit("wails from the grave", "lamentos desde la tumba", "lamentos de la tumba")) return 20;
  if (hit("bardic inspiration", "inspiracion bardica")) return 30;
  if (hit("lucky", "afortunad", "suerte")) return 40;
  if (hit("channel divinity", "canalizar")) return 50;
  if (hit("warding flare", "destello protector", "llamarada protectora")) return 60;
  return 100;
}

function effectStatusKeys(effect) {
  const raw = effect?.statuses;
  if (!raw) return [];
  try { return Array.from(raw.values ? raw.values() : raw).map((v) => String(v || "")); } catch (_) { return []; }
}

function hasConcentration(actor) {
  try {
    const hit = Array.from(actor?.effects || []).some((effect) => {
      if (!effect || effect.disabled) return false;
      const dnd5e = gp(effect, "flags.dnd5e.concentration") || gp(effect, "flags.dnd5e.isConcentration");
      return norm(effect.name || effect.label).includes("concentr") || norm(effect.img || effect.icon).includes("concentr")
        || norm(effect.origin || gp(effect, "flags.dnd5e.origin")).includes("concentr") || dnd5e === true
        || effectStatusKeys(effect).some((s) => norm(s).includes("concentr"));
    });
    if (hit) return true;
  } catch (_) {}
  try {
    const st = actor?.statuses;
    if (st?.has?.("concentrating") || st?.has?.("concentration")) return true;
    for (const s of Array.from(st || [])) if (norm(s).includes("concentr")) return true;
  } catch (_) {}
  try {
    const own = leerFlag(actor, FLAG_CONCENTRATION);
    if (own && (own.name || own.active || typeof own === "string")) return true;
  } catch (_) {}
  return false;
}

function hasNamedFeature(actor, keys = []) {
  const items = actor?.items?.contents || actor?.items || [];
  return Array.from(items).some((item) => {
    const hay = `${norm(item?.name)} ${norm(gp(item, "system.identifier") || "")}`.trim();
    return keys.some((key) => hay.includes(norm(key)));
  });
}

export function collectQuickTraits(actor) {
  const out = [];
  if (hasConcentration(actor)) out.push({ id: "concentration", label: t("OLATTACK.Scene.Trait.concentration"), shortLabel: t("OLATTACK.Scene.Trait.concentrationShort"), tone: "magic", hint: t("OLATTACK.Scene.Trait.concentrationHint") });
  if (hasNamedFeature(actor, ["multiattack", "multiataque", "ataque multiple"])) out.push({ id: "multiattack", label: t("OLATTACK.Scene.Trait.multiattack"), shortLabel: t("OLATTACK.Scene.Trait.multiattackShort"), tone: "feature", hint: t("OLATTACK.Scene.Trait.multiattackHint") });
  if (hasNamedFeature(actor, ["legendary resistance", "resistencia legendaria"])) out.push({ id: "legendary-resistance", label: t("OLATTACK.Scene.Trait.legendary"), shortLabel: "RL", tone: "feature", hint: t("OLATTACK.Scene.Trait.legendaryHint") });
  return out;
}

export function collectStatuses(actor) {
  const seen = new Set();
  const out = [];
  for (const effect of actor?.effects || []) {
    if (!effect || effect.disabled) continue;
    const label = String(effect.name || effect.label || "").trim();
    const icon = effect.img || effect.icon || "icons/svg/aura.svg";
    const key = `${label}__${icon}`;
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: effect.id || key, label, icon });
  }
  return out;
}

export function collectResources(actor, limit = Infinity) {
  const items = actor?.items?.contents || actor?.items || [];
  const out = [];
  for (const item of items) {
    const uses = getItemUses(item);
    if (uses.max <= 0) continue;
    const type = String(item?.type || "");
    if (!(["spell", "feat", "class", "consumable"].includes(type) || resourcePriority(item) < 100)) continue;
    out.push({ id: item.id, name: item.name, shortName: item.name, remaining: uses.remaining, max: uses.max, priority: resourcePriority(item), depleted: uses.remaining <= 0 });
  }
  out.sort((a, b) => Number(a.depleted) - Number(b.depleted) || a.priority - b.priority || a.name.localeCompare(b.name, game.i18n.lang));
  return Number.isFinite(limit) ? out.slice(0, Math.max(0, limit)) : out;
}

export function collectSpellSlots(actor) {
  return getAvailableSpellSlots(actor).map((slot) => ({
    key: slot.key, level: slot.level, value: slot.value, max: slot.max,
    label: slot.key === "pact" ? t("OLATTACK.Spell.Pact", { n: slot.level }) : t("OLATTACK.Spell.Level", { n: slot.level }),
    shortLabel: slot.key === "pact" ? `P${slot.level}` : `${slot.level}`,
    depleted: Number(slot.value || 0) <= 0
  }));
}

function traitEntries(raw, custom) {
  const arr = [];
  try {
    const values = Array.isArray(raw?.value) ? raw.value : (raw?.value instanceof Set ? Array.from(raw.value) : []);
    for (const v of values) if (String(v || "").trim()) arr.push(String(v).trim());
  } catch (_) {}
  if (String(custom || "").trim()) arr.push(String(custom).trim());
  return arr;
}

export function collectWeaknessSummary(actor) {
  const traits = getActorTraits(actor) || {};
  const vulnerability = traitEntries(traits.dv, traits.dv?.custom);
  const resistance = traitEntries(traits.dr, traits.dr?.custom);
  const immunity = traitEntries(traits.di, traits.di?.custom);
  return { vulnerability, resistance, immunity, hasAny: !!(vulnerability.length || resistance.length || immunity.length) };
}

// ---------- Imágenes ----------
export const isVideoPath = (src) => /\.(webm|mp4|m4v|mov)(\?.*)?$/.test(String(src || "").trim().toLowerCase());
export const isGenericPortrait = (src) => {
  const v = norm(src);
  return !v || v.includes("icons/svg/mystery-man.svg") || v.includes("icons/svg/hazard.svg");
};

export function collectAvailablePortraitOptions(actor, token) {
  const entries = [
    { key: "actor", label: t("OLATTACK.Scene.Img.actor"), src: String(actor?.img || "").trim() },
    { key: "token", label: t("OLATTACK.Scene.Img.token"), src: String(token?.document?.texture?.src || token?.texture?.src || "").trim() },
    { key: "prototype", label: t("OLATTACK.Scene.Img.prototype"), src: String(gp(actor, "prototypeToken.texture.src") || "").trim() }
  ];
  const seen = new Set();
  return entries.filter((e) => e.src && !seen.has(e.src) && seen.add(e.src));
}

export function imageModeLabel(mode, actor) {
  const normalized = String(mode || "auto");
  if (normalized === "auto") return t(isGenericPortrait(actor?.img) ? "OLATTACK.Scene.Img.autoToken" : "OLATTACK.Scene.Img.autoActor");
  return t(`OLATTACK.Scene.Img.${normalized}`);
}

export function resolvePortraitChoice(actor, token, choice = {}) {
  const available = collectAvailablePortraitOptions(actor, token);
  const pick = (k) => available.find((o) => o.key === k)?.src || "";
  const actorImg = pick("actor") || String(actor?.img || "").trim();
  const tokenImg = pick("token");
  const prototypeImg = pick("prototype");
  const mode = String(choice?.mode || "auto");
  const custom = String(choice?.custom || "").trim();
  const genericActor = isGenericPortrait(actorImg);
  const autoPortrait = !genericActor ? actorImg : (tokenImg || prototypeImg || actorImg || "icons/svg/mystery-man.svg");
  let avatar = tokenImg || prototypeImg || (!genericActor ? actorImg : "") || "icons/svg/mystery-man.svg";
  // Un <img> no reproduce vídeo: si el token es animado se usa el retrato del actor.
  if (isVideoPath(avatar)) avatar = (!isVideoPath(actorImg) && actorImg) || "icons/svg/mystery-man.svg";
  let portrait = autoPortrait;
  if (mode === "custom" && custom) portrait = custom;
  else if (mode === "actor") portrait = actorImg || tokenImg || prototypeImg || autoPortrait;
  else if (mode === "token") portrait = tokenImg || prototypeImg || actorImg || autoPortrait;
  else if (mode === "prototype") portrait = prototypeImg || tokenImg || actorImg || autoPortrait;
  return { portrait: portrait || autoPortrait, avatar, available, mode, custom };
}

// ---------- Fila ----------
/**
 * @param {Token} token
 * @param {object} extra      Estado del combate y de la selección (ver monitores).
 * @param {object} [opts]
 * @param {object} [opts.visuals]   Ajustes visuales (fondo con retrato).
 * @param {boolean} [opts.player]   Vista de jugador (otro criterio para la tirada de muerte).
 * @param {number} [opts.resourceLimit]
 * @param {boolean} [opts.withSlots]
 */
export function buildRow(token, extra = {}, { visuals = defaultVisualSettings(), player = false, resourceLimit = Infinity, withSlots = false } = {}) {
  const actor = token?.actor;
  const hp = hpDisplay(getActorHpData(actor));
  const portraits = resolvePortraitChoice(actor, token, extra.imageChoice || {});
  const hasInitiative = Number.isFinite(Number(extra.initiative));
  const targetedTokenId = String(extra.targetedTokenId || "");
  const bgMedia = String(portraits.portrait || portraits.avatar || "").trim();
  const opacity = clamp((Number(extra.opacity ?? visuals.backgroundOpacity) || 40) / 100, 0, 0.95);
  const overlay = clamp((Number(visuals.overlayOpacity) || 60) / 100, 0.05, 0.95);
  const bgSize = ["cover", "contain"].includes(String(visuals.backgroundSize || "cover")) ? String(visuals.backgroundSize) : "cover";
  const usesBg = !!visuals.usePortraitBackground && !!bgMedia;
  return {
    tokenId: String(token.id),
    tokenName: token.name || actor?.name,
    actorId: actor?.id,
    actorName: actor?.name,
    img: portraits.avatar,
    // El encuadre de retrato solo vale para la imagen del propio actor.
    retratoId: portraits.avatar === actor?.img ? actor.id : "",
    actorImg: portraits.portrait,
    bgMedia,
    bgMediaIsVideo: isVideoPath(bgMedia),
    isPC: !!actor?.hasPlayerOwner,
    hidden: !!token.document?.hidden,
    hp,
    death: deathSaveDisplay(actor, hp, { player }),
    resources: collectResources(actor, resourceLimit),
    spellSlots: withSlots ? collectSpellSlots(actor) : [],
    statuses: collectStatuses(actor),
    quickTraits: collectQuickTraits(actor),
    weaknesses: collectWeaknessSummary(actor),
    initiative: hasInitiative ? Number(extra.initiative) : null,
    hasInitiative,
    turnIndex: Number.isFinite(Number(extra.turnIndex)) ? Number(extra.turnIndex) : null,
    inCombat: !!extra.inCombat,
    isActiveTurn: !!extra.isActiveTurn,
    pendingInitiative: !hasInitiative,
    selectionVisible: !!extra.selectionVisible,
    selectionCombat: !!extra.selectionCombat,
    isGmHandled: !!extra.isGmHandled,
    isOwnedByUser: !!extra.isOwnedByUser,
    isTargetedByUser: !!targetedTokenId && targetedTokenId === String(token.id),
    hasPortraitBackground: usesBg,
    showAvatar: !visuals.usePortraitBackground,
    cardStyle: usesBg ? `--ol-card-bg-opacity:${opacity}; --ol-card-overlay-opacity:${overlay}; --ol-card-bg-size:${bgSize};` : "",
    // Qué bloques se pintan. El GM lo ve todo; la vista de jugador los recorta (ver redactRow).
    showHP: true, showTempHP: true, showDeath: true, showResources: true, showSpellSlots: withSlots,
    showStatuses: true, showQuickTraits: true, showWeaknesses: false, showWeaknessDetails: false
  };
}

/** Un PNJ ajeno nunca muestra datos a los jugadores. */
export function redactRow(row) {
  Object.assign(row, {
    hp: hpDisplay({ value: 0, max: 0, temp: 0 }),
    death: { visible: false, successes: 0, failures: 0, stateLabel: "", successDots: [], failureDots: [] },
    resources: [], spellSlots: [], statuses: [], quickTraits: [],
    weaknesses: { vulnerability: [], resistance: [], immunity: [] },
    showHP: false, showTempHP: false, showDeath: false, showResources: false, showSpellSlots: false,
    showStatuses: false, showQuickTraits: false, showWeaknesses: false, showWeaknessDetails: false,
    enemyPrivate: true
  });
  return row;
}

export function buildCombatMeta(rows = [], extra = {}) {
  const selectedCount = rows.length;
  const rolledCount = rows.filter((r) => r.hasInitiative).length;
  return {
    selectedCount,
    rolledCount,
    pendingCount: Math.max(0, selectedCount - rolledCount),
    pendingPlayers: rows.filter((r) => r.isPC && !r.hasInitiative).length,
    pendingNpcs: rows.filter((r) => !r.isPC && !r.hasInitiative).length,
    ...extra
  };
}
