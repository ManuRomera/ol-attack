import { MODULE_ID, SETTING_SYSTEM_ADAPTER_CONFIG } from "./constants.js";

const DEFAULT_CONFIG = {
  profile: "dnd5e-2024",
  allowAnySystemSheetButton: false,
  allowAnySystemTokenHud: false,
  hpValuePath: "system.attributes.hp.value",
  hpMaxPath: "system.attributes.hp.max",
  hpTempPath: "system.attributes.hp.temp",
  hpTempMaxPath: "system.attributes.hp.tempmax",
  deathSuccessPath: "system.attributes.death.success",
  deathFailurePath: "system.attributes.death.failure",
  traitsRootPath: "system.traits",
  spellSlotsRootPath: "system.spells",
  profPath: "system.attributes.prof",
  spellDcPath: "system.attributes.spelldc",
  spellcastingAbilityPath: "system.attributes.spellcasting",
  abilitiesRootPath: "system.abilities",
  classesPath: "system.classes",
  levelPath: "system.details.level",
  crPath: "system.details.cr",
  acPath: "system.attributes.ac.value"
};

function _clone(v) {
  return foundry.utils.deepClone(v);
}

function _merge(base = {}, extra = {}) {
  return foundry.utils.mergeObject(_clone(base), _clone(extra || {}), { inplace: false, overwrite: true, insertKeys: true, insertValues: true });
}

function _cleanPath(path, fallback = "") {
  const s = String(path ?? "").trim();
  return s || fallback;
}

export function getDefaultSystemAdapterConfig() {
  return _clone(DEFAULT_CONFIG);
}

export function normalizeSystemAdapterConfig(raw = {}) {
  const merged = _merge(DEFAULT_CONFIG, raw || {});
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (typeof DEFAULT_CONFIG[key] === 'string') merged[key] = _cleanPath(merged[key], DEFAULT_CONFIG[key]);
  }
  merged.profile = ["dnd5e-2024", "custom"].includes(String(merged.profile || "")) ? String(merged.profile) : "dnd5e-2024";
  merged.allowAnySystemSheetButton = !!merged.allowAnySystemSheetButton;
  merged.allowAnySystemTokenHud = !!merged.allowAnySystemTokenHud;
  return merged;
}

export function getSystemAdapterConfig() {
  try {
    const raw = game.settings.get(MODULE_ID, SETTING_SYSTEM_ADAPTER_CONFIG) || {};
    return normalizeSystemAdapterConfig(raw);
  } catch (_) {
    return getDefaultSystemAdapterConfig();
  }
}

function _gp(obj, path, fallback = undefined) {
  if (!obj || !path) return fallback;
  const val = foundry.utils.getProperty(obj, path);
  return val === undefined ? fallback : val;
}

export function getConfiguredValue(obj, path, fallback = undefined) {
  return _gp(obj, path, fallback);
}

export function getActorHpData(actor) {
  const cfg = getSystemAdapterConfig();
  return {
    value: Number(_gp(actor, cfg.hpValuePath, 0)) || 0,
    max: Number(_gp(actor, cfg.hpMaxPath, 0)) || 0,
    temp: Number(_gp(actor, cfg.hpTempPath, 0)) || 0,
    tempmax: Number(_gp(actor, cfg.hpTempMaxPath, 0)) || 0
  };
}

export async function updateActorHpData(actor, patch = {}) {
  const cfg = getSystemAdapterConfig();
  const update = {};
  if (patch.value !== undefined) update[cfg.hpValuePath] = Number(patch.value) || 0;
  if (patch.max !== undefined) update[cfg.hpMaxPath] = Number(patch.max) || 0;
  if (patch.temp !== undefined) update[cfg.hpTempPath] = Number(patch.temp) || 0;
  if (patch.tempmax !== undefined) update[cfg.hpTempMaxPath] = Number(patch.tempmax) || 0;
  if (!Object.keys(update).length) return null;
  return actor.update(update);
}

export function getActorDeathSaveData(actor) {
  const cfg = getSystemAdapterConfig();
  return {
    success: Number(_gp(actor, cfg.deathSuccessPath, 0)) || 0,
    failure: Number(_gp(actor, cfg.deathFailurePath, 0)) || 0
  };
}

export function getActorTraits(actor) {
  const cfg = getSystemAdapterConfig();
  const traits = _gp(actor, cfg.traitsRootPath, {});
  return traits && typeof traits === 'object' ? traits : {};
}

export function getActorTraitEntry(actor, traitKey) {
  const traits = getActorTraits(actor);
  return traits?.[traitKey] || {};
}

export function getActorSpellSlots(actor) {
  const cfg = getSystemAdapterConfig();
  const raw = _gp(actor, cfg.spellSlotsRootPath, {});
  return raw && typeof raw === 'object' ? raw : {};
}

export function getActorProfValue(actor) {
  const cfg = getSystemAdapterConfig();
  return Number(_gp(actor, cfg.profPath, NaN));
}

export function getActorSpellDc(actor) {
  const cfg = getSystemAdapterConfig();
  return Number(_gp(actor, cfg.spellDcPath, NaN));
}

export function getActorSpellcastingAbility(actor) {
  const cfg = getSystemAdapterConfig();
  const raw = _gp(actor, cfg.spellcastingAbilityPath, "");
  if (typeof raw === 'string') return raw.trim().toLowerCase();
  if (raw && typeof raw === 'object') {
    const val = raw.value ?? raw.ability ?? raw.key ?? "";
    return String(val || "").trim().toLowerCase();
  }
  return "";
}

export function getActorAbilityMod(actor, ability) {
  const cfg = getSystemAdapterConfig();
  const root = _cleanPath(cfg.abilitiesRootPath, DEFAULT_CONFIG.abilitiesRootPath);
  const ab = String(ability || "").trim().toLowerCase();
  if (!ab) return 0;
  return Number(_gp(actor, `${root}.${ab}.mod`, 0)) || 0;
}

export function getActorAbilitySaveBonus(actor, ability) {
  const cfg = getSystemAdapterConfig();
  const root = _cleanPath(cfg.abilitiesRootPath, DEFAULT_CONFIG.abilitiesRootPath);
  const ab = String(ability || "").trim().toLowerCase();
  if (!ab) return 0;
  const raw = Number(_gp(actor, `${root}.${ab}.save`, NaN));
  return Number.isFinite(raw) ? raw : getActorAbilityMod(actor, ab);
}

export function getActorClasses(actor) {
  const cfg = getSystemAdapterConfig();
  const raw = _gp(actor, cfg.classesPath, {});
  return raw && typeof raw === 'object' ? raw : {};
}

export function getActorLevel(actor) {
  const cfg = getSystemAdapterConfig();
  return Number(_gp(actor, cfg.levelPath, 0)) || 0;
}

export function getActorChallenge(actor) {
  const cfg = getSystemAdapterConfig();
  return Number(_gp(actor, cfg.crPath, 0)) || 0;
}

export function getActorAcValue(actor) {
  const cfg = getSystemAdapterConfig();
  return Number(_gp(actor, cfg.acPath, NaN));
}

export function buildSpellSlotValuePath(slotKey) {
  const cfg = getSystemAdapterConfig();
  const root = _cleanPath(cfg.spellSlotsRootPath, DEFAULT_CONFIG.spellSlotsRootPath);
  return `${root}.${slotKey}.value`;
}

export function shouldShowSheetButtonsForCurrentSystem() {
  if (game.system?.id === 'dnd5e') return true;
  return !!getSystemAdapterConfig().allowAnySystemSheetButton;
}

export function shouldShowTokenHudForCurrentSystem() {
  if (game.system?.id === 'dnd5e') return true;
  return !!getSystemAdapterConfig().allowAnySystemTokenHud;
}
