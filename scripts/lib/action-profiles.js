import { FLAG_SCOPE, MODULE_ID, FLAG_ACTION_PROFILE_OVERRIDE, SETTING_ACTION_PROFILE_REGISTRY } from "../shared/constants.js";
import { gp, safeNum, sanitizeFormulaLoose } from "./utils.js";
import { getActivities } from "./actor.js";
import { getDamagePartsDetailed, getHealingPartsDetailed } from "./damage.js";
import { inferBonusDie, inferAutoEffectRoll } from "./trait-infer.js";

const DEFAULT_PROFILE = {
  mode: "auto",
  rollSource: "auto",
  activityId: "",
  manualFormula: "",
  manualType: "force",
  cardType: "auto",
  consume: "auto",
  choiceConsumeHeal: "auto",
  choiceConsumeDamage: "auto",
  showSave: "auto",
  showDescription: "auto",
  autoApplyDamageOnFailedSave: false,
  autoApplyStatusOnFailedSave: false,
  saveFailStatusId: "",
  effectNoteTitle: "",
  effectNoteText: "",
  hidden: false,
  specialFeatureKey: "",
  specialCounterKey: "",
  variants: {},
  jsonConfig: null
};



export const ACTION_CONFIG_VERSION = 1;
export const ACTION_CONFIG_ENGINE = "ol-attack.action-config";
export const ACTION_PROFILE_MODES = ["auto","damage","heal","choice","effect","effectRoll","bonusdie","hidden","workflow"];
export const ACTION_PROFILE_ROLL_SOURCES = ["auto","activity","damage","healing","manual","none"];
export const ACTION_PROFILE_CARD_TYPES = ["auto","damage","heal","effect","choice","bonusdie","effectRoll"];
export const ACTION_PROFILE_CONSUME_TYPES = ["auto","none","uses","slot","both","manual","choice"];
export const ACTION_PROFILE_SAVE_VISIBILITY = ["auto","always","never"];
export const ACTION_PROFILE_DESCRIPTION_VISIBILITY = ["auto","show","hide"];
export const ACTION_CONFIG_STEP_TYPES = ["damageRoll","healRoll","effectText","applyStatus","removeStatus","choice","bonusDie"];
export const ACTION_CONFIG_TARGETING_MODES = ["selected","chooseOne","self","none","targetIndex"];

function _isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function _enumOr(value, allowed, fallback) {
  const raw = String(value ?? "").trim();
  return allowed.includes(raw) ? raw : fallback;
}

function _safeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function _normalizeWorkflowStep(step = {}, index = 0) {
  const type = _enumOr(step?.type, ACTION_CONFIG_STEP_TYPES, "effectText");
  const out = {
    id: String(step?.id || `step-${index + 1}`).trim() || `step-${index + 1}`,
    type,
    label: String(step?.label || "").trim(),
    targeting: _enumOr(step?.targeting, ACTION_CONFIG_TARGETING_MODES, type === "effectText" ? "none" : "selected"),
    targetIndex: _safeInt(step?.targetIndex, 0),
    repeat: Math.max(1, _safeInt(step?.repeat, 1)),
    description: String(step?.description || "").trim(),
    formula: "",
    damageType: "force",
    statusId: "",
    active: step?.active !== false
  };

  if (["damageRoll", "healRoll", "bonusDie"].includes(type)) {
    out.formula = sanitizeFormulaLoose(step?.formula || "") || "1d6";
    out.damageType = String(step?.damageType || (type === "healRoll" ? "healing" : type === "bonusDie" ? "bonus" : "force")).trim() || (type === "healRoll" ? "healing" : type === "bonusDie" ? "bonus" : "force");
  }

  if (["applyStatus", "removeStatus"].includes(type)) {
    out.statusId = String(step?.statusId || "").trim();
    out.active = type === "applyStatus" ? true : false;
  }

  if (type === "choice") {
    const rawBranches = _isPlainObject(step?.branches) ? step.branches : {};
    const branches = {};
    for (const [branchKey, branchValue] of Object.entries(rawBranches)) {
      const bKey = String(branchKey || "").trim();
      if (!bKey) continue;
      const steps = Array.isArray(branchValue?.steps) ? branchValue.steps.map((child, childIndex) => _normalizeWorkflowStep(child, childIndex)) : [];
      branches[bKey] = {
        label: String(branchValue?.label || bKey).trim() || bKey,
        description: String(branchValue?.description || "").trim(),
        steps
      };
    }
    out.branches = branches;
  }

  return out;
}

function _normalizeActionConfigJson(config = {}, fallbackProfile = null) {
  const profile = mergeProfile(fallbackProfile || {});
  const raw = _isPlainObject(config) ? config : {};
  const normalized = {
    engine: ACTION_CONFIG_ENGINE,
    version: ACTION_CONFIG_VERSION,
    mode: _enumOr(raw.mode, ACTION_PROFILE_MODES, profile.mode || "auto"),
    rollSource: _enumOr(raw.rollSource, ACTION_PROFILE_ROLL_SOURCES, profile.rollSource || "auto"),
    activityId: String(raw.activityId ?? profile.activityId ?? "").trim(),
    manualFormula: sanitizeFormulaLoose(raw.manualFormula || profile.manualFormula || ""),
    manualType: String(raw.manualType ?? profile.manualType ?? "force").trim() || "force",
    cardType: _enumOr(raw.cardType, ACTION_PROFILE_CARD_TYPES, profile.cardType || "auto"),
    consume: _enumOr(raw.consume, ACTION_PROFILE_CONSUME_TYPES, profile.consume || "auto"),
    choiceConsumeHeal: _enumOr(raw.choiceConsumeHeal, ACTION_PROFILE_CONSUME_TYPES, profile.choiceConsumeHeal || "auto"),
    choiceConsumeDamage: _enumOr(raw.choiceConsumeDamage, ACTION_PROFILE_CONSUME_TYPES, profile.choiceConsumeDamage || "auto"),
    showSave: _enumOr(raw.showSave, ACTION_PROFILE_SAVE_VISIBILITY, profile.showSave || "auto"),
    showDescription: _enumOr(raw.showDescription, ACTION_PROFILE_DESCRIPTION_VISIBILITY, profile.showDescription || "auto"),
    autoApplyDamageOnFailedSave: !!(raw.autoApplyDamageOnFailedSave ?? profile.autoApplyDamageOnFailedSave),
    autoApplyStatusOnFailedSave: !!(raw.autoApplyStatusOnFailedSave ?? profile.autoApplyStatusOnFailedSave),
    saveFailStatusId: String(raw.saveFailStatusId ?? profile.saveFailStatusId ?? "").trim(),
    effectNoteTitle: String(raw.effectNoteTitle ?? profile.effectNoteTitle ?? "").trim(),
    effectNoteText: String(raw.effectNoteText ?? profile.effectNoteText ?? "").trim(),
    hidden: !!(raw.hidden ?? profile.hidden),
    specialFeatureKey: String(raw.specialFeatureKey ?? profile.specialFeatureKey ?? "").trim(),
    specialCounterKey: String(raw.specialCounterKey ?? profile.specialCounterKey ?? "").trim(),
    variants: _isPlainObject(raw.variants) ? clone(raw.variants) : clone(profile.variants || {}),
    workflow: null
  };

  if (_isPlainObject(raw.workflow)) {
    normalized.workflow = {
      targeting: {
        default: _enumOr(raw.workflow?.targeting?.default, ACTION_CONFIG_TARGETING_MODES, "selected"),
        min: Math.max(0, _safeInt(raw.workflow?.targeting?.min, 0)),
        max: raw.workflow?.targeting?.max == null ? null : Math.max(1, _safeInt(raw.workflow?.targeting?.max, 1))
      },
      steps: Array.isArray(raw.workflow?.steps) ? raw.workflow.steps.map((step, index) => _normalizeWorkflowStep(step, index)) : []
    };
  }

  return normalized;
}

export function profileToActionConfigJson(profile = {}, meta = {}) {
  const p = mergeProfile(profile || {});
  const source = p?.jsonConfig && _isPlainObject(p.jsonConfig) ? p.jsonConfig : { ...p, workflow: p?.jsonConfig?.workflow || null };
  const normalized = _normalizeActionConfigJson(source, p);
  if (normalized.mode !== "workflow") delete normalized.workflow;
  if (meta?.itemName) normalized.itemName = String(meta.itemName);
  if (meta?.identifier) normalized.identifier = String(meta.identifier);
  return normalized;
}

export function actionConfigJsonToProfile(config = {}, fallbackProfile = null) {
  const normalized = _normalizeActionConfigJson(config, fallbackProfile || {});
  return mergeProfile({
    ...(fallbackProfile || {}),
    mode: normalized.mode,
    rollSource: normalized.rollSource,
    activityId: normalized.activityId,
    manualFormula: normalized.manualFormula,
    manualType: normalized.manualType,
    cardType: normalized.cardType,
    consume: normalized.consume,
    choiceConsumeHeal: normalized.choiceConsumeHeal,
    choiceConsumeDamage: normalized.choiceConsumeDamage,
    showSave: normalized.showSave,
    showDescription: normalized.showDescription,
    autoApplyDamageOnFailedSave: normalized.autoApplyDamageOnFailedSave,
    autoApplyStatusOnFailedSave: normalized.autoApplyStatusOnFailedSave,
    saveFailStatusId: normalized.saveFailStatusId,
    effectNoteTitle: normalized.effectNoteTitle,
    effectNoteText: normalized.effectNoteText,
    hidden: normalized.hidden,
    specialFeatureKey: normalized.specialFeatureKey,
    specialCounterKey: normalized.specialCounterKey,
    variants: normalized.variants || {},
    jsonConfig: normalized
  });
}

export function validateActionConfigJson(config = {}, fallbackProfile = null) {
  const errors = [];
  const warnings = [];
  if (!_isPlainObject(config)) errors.push("El JSON debe ser un objeto en la raíz.");
  const normalized = _normalizeActionConfigJson(config, fallbackProfile || {});

  if (String(config?.engine || ACTION_CONFIG_ENGINE) !== ACTION_CONFIG_ENGINE) warnings.push(`engine distinto de ${ACTION_CONFIG_ENGINE}; se normalizará.`);
  if (normalized.mode === "workflow") {
    if (!normalized.workflow || !Array.isArray(normalized.workflow.steps) || !normalized.workflow.steps.length) {
      errors.push("workflow.steps debe ser un array con al menos un paso cuando mode = workflow.");
    }
    for (const [idx, step] of Array.from(normalized.workflow?.steps || []).entries()) {
      if (["damageRoll", "healRoll", "bonusDie"].includes(step.type) && !String(step.formula || "").trim()) {
        errors.push(`Paso ${idx + 1}: formula es obligatoria para ${step.type}.`);
      }
      if (["applyStatus", "removeStatus"].includes(step.type) && !String(step.statusId || "").trim()) {
        errors.push(`Paso ${idx + 1}: statusId es obligatorio para ${step.type}.`);
      }
      if (step.type === "choice") {
        const entries = Object.entries(step.branches || {});
        if (!entries.length) errors.push(`Paso ${idx + 1}: choice necesita branches.`);
        for (const [branchKey, branch] of entries) {
          if (!Array.isArray(branch?.steps) || !branch.steps.length) errors.push(`Paso ${idx + 1}: la rama ${branchKey} debe contener steps.`);
        }
      }
    }
  }

  return { ok: !errors.length, errors, warnings, normalized };
}

export function getWorkflowConfigFromProfile(profile = {}) {
  const p = mergeProfile(profile || {});
  const raw = p?.jsonConfig && _isPlainObject(p.jsonConfig) ? p.jsonConfig : null;
  const normalized = raw ? _normalizeActionConfigJson(raw, p) : null;
  if (p.mode === "workflow" || normalized?.mode === "workflow") {
    return normalized?.workflow ? normalized : _normalizeActionConfigJson({ mode: "workflow", workflow: { steps: [] } }, p);
  }
  return null;
}
function norm(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function clone(obj) {
  return foundry.utils.deepClone(obj);
}

export function mergeProfile(profile = {}) {
  return foundry.utils.mergeObject(clone(DEFAULT_PROFILE), clone(profile || {}), { inplace: false, overwrite: true, recursive: true });
}

function normalizeName(name) {
  return norm(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeSourceId(item) {
  const raw = String(item?.flags?.core?.sourceId || item?.sourceId || "").trim();
  if (!raw) return "";
  return raw.toLowerCase();
}

function serializePartTypes(parts = []) {
  return parts.map((p) => norm(gp(p, "type") || gp(p, "types") || (Array.isArray(p) ? p[1] : ""))).filter(Boolean).join(",");
}

export function computeItemFingerprint(item) {
  const activities = getActivities(item);
  const activityTypes = activities.map((a) => `${norm(a?.type)}:${String(a?.id || a?._id || "")}`).filter(Boolean);
  const damageParts = getDamagePartsDetailed(item, { actor: null }) || [];
  const healParts = getHealingPartsDetailed(item, { actor: null }) || [];
  const save = activities.some((a) => a?.type === "save" || a?.save);
  const usesMax = safeNum(gp(item, "system.uses.max"), 0);
  const base = [
    norm(item?.type),
    norm(gp(item, "system.identifier")),
    normalizeSourceId(item),
    activityTypes.join("|"),
    `d:${damageParts.length}:${serializePartTypes(damageParts)}`,
    `h:${healParts.length}:${serializePartTypes(healParts)}`,
    `s:${save ? 1 : 0}`,
    `u:${usesMax > 0 ? 1 : 0}`
  ].join("::");
  return base;
}

export function getItemProfileCandidates(item) {
  const out = [];
  const seen = new Set();
  const push = (type, key, label) => {
    const k = String(key || "").trim();
    if (!k || seen.has(`${type}:${k}`)) return;
    seen.add(`${type}:${k}`);
    out.push({ type, key: `${type}:${k}`, rawKey: k, label: label || `${type}:${k}` });
  };

  const ident = norm(gp(item, "system.identifier"));
  if (ident) push("identifier", ident, `Identifier · ${ident}`);

  const sourceId = normalizeSourceId(item);
  if (sourceId) push("sourceId", sourceId, `SourceId · ${sourceId}`);

  for (const a of getActivities(item)) {
    const id = String(a?.id || a?._id || "").trim();
    if (id) push("activityId", id, `Activity · ${id}`);
  }

  const fingerprint = computeItemFingerprint(item);
  if (fingerprint) push("fingerprint", fingerprint, "Huella estructural");

  const name = normalizeName(item?.name);
  if (name) push("legacyName", name, `Nombre normalizado · ${name}`);

  return out;
}

function getRegistry() {
  return foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTING_ACTION_PROFILE_REGISTRY) || { profiles: {} });
}

async function setRegistry(registry) {
  const safe = registry && typeof registry === "object" ? registry : { profiles: {} };
  await game.settings.set(MODULE_ID, SETTING_ACTION_PROFILE_REGISTRY, safe);
  return safe;
}

export function getGlobalActionProfiles() {
  const reg = getRegistry();
  return reg?.profiles || {};
}

export async function saveGlobalActionProfile(matchKey, profile) {
  const reg = getRegistry();
  reg.profiles ||= {};
  reg.profiles[matchKey] = mergeProfile(profile);
  await setRegistry(reg);
  return reg.profiles[matchKey];
}

export async function deleteGlobalActionProfile(matchKey) {
  const reg = getRegistry();
  reg.profiles ||= {};
  delete reg.profiles[matchKey];
  await setRegistry(reg);
}

export async function replaceGlobalActionProfiles(nextProfiles = {}) {
  await setRegistry({ profiles: nextProfiles || {} });
}

export function getItemActionProfileOverride(item) {
  const raw = item?.getFlag?.(FLAG_SCOPE, FLAG_ACTION_PROFILE_OVERRIDE);
  if (!raw || typeof raw !== "object") return null;
  return mergeProfile(raw);
}

export async function setItemActionProfileOverride(item, profile) {
  return item.setFlag(FLAG_SCOPE, FLAG_ACTION_PROFILE_OVERRIDE, mergeProfile(profile));
}

export async function clearItemActionProfileOverride(item) {
  return item.unsetFlag(FLAG_SCOPE, FLAG_ACTION_PROFILE_OVERRIDE);
}

function inferSpecialKeys(item) {
  const name = norm(item?.name);
  const ident = norm(gp(item, "system.identifier"));
  const hay = `${name} ${ident}`.trim();
  const hit = (...parts) => parts.some((p) => hay.includes(norm(p)));

  let specialFeatureKey = "";
  if (hit("rage", "furia", "rabia")) specialFeatureKey = "rage";
  else if (hit("reckless", "temerario")) specialFeatureKey = "reckless";
  else if (hit("frenzy", "frenesi")) specialFeatureKey = "frenzy";
  else if (hit("sneak attack", "ataque furtivo")) specialFeatureKey = "sneak";
  else if (hit("savage attacker", "atacante salvaje")) specialFeatureKey = "savage";
  else if (hit("wails from the grave", "lamentos desde la tumba", "lamentos de la tumba")) specialFeatureKey = "wails";

  let specialCounterKey = "";
  if (hit("bardic inspiration", "inspiracion bardica", "inspiración bardica")) specialCounterKey = "bardic-inspiration";
  else if (hit("lucky", "afortunad", "suerte")) specialCounterKey = "lucky";
  else if (hit("rage", "furia", "rabia")) specialCounterKey = "rage";
  else if (hit("stone's endurance", "stones endurance", "resistencia de piedra", "piel de piedra")) specialCounterKey = "stone-endurance";
  else if (hit("wails from the grave", "lamentos desde la tumba", "lamentos de la tumba")) specialCounterKey = "wails-from-the-grave";
  else if (hit("channel divinity", "canalizar divinidad", "canalizar")) specialCounterKey = "channel-divinity";
  else if (hit("warding flare", "destello protector", "llamarada protectora", "fulgor protector")) specialCounterKey = "warding-flare";

  return { specialFeatureKey, specialCounterKey };
}

function isGuidingBoltLike(item) {
  const ident = norm(gp(item, "system.identifier"));
  const nm = norm(item?.name);
  return ident === "guidingbolt" || ident === "guiding-bolt" || /\bguiding\s+bolt\b/.test(nm) || /\bsaeta\s+gu[ií]a\b/.test(nm);
}

function repairKnownMisclassifiedProfile(item, actor, resolved) {
  if (!resolved?.profile) return resolved;
  const profile = mergeProfile(resolved.profile);
  const damageParts = getDamagePartsDetailed(item, { actor }) || [];
  if (isGuidingBoltLike(item) && damageParts.length && profile.mode === "bonusdie") {
    const repaired = mergeProfile({
      ...profile,
      mode: "damage",
      rollSource: "auto",
      manualFormula: "",
      cardType: "damage",
      showDescription: "show",
      effectNoteTitle: profile.effectNoteTitle || "Impacto guiado",
      effectNoteText: profile.effectNoteText || "Si impacta, la siguiente tirada de ataque contra este objetivo antes del final de tu próximo turno tiene ventaja.",
      jsonConfig: null
    });
    return {
      ...resolved,
      profile: repaired,
      source: `${resolved.source || "profile"}-repaired-guiding-bolt`
    };
  }
  return resolved;
}

function inferLegacyProfile(item, actor) {
  const damageParts = getDamagePartsDetailed(item, { actor }) || [];
  const healParts = getHealingPartsDetailed(item, { actor }) || [];
  const bonusDie = inferBonusDie(item, actor);
  const effectRoll = inferAutoEffectRoll(item);
  const { specialFeatureKey, specialCounterKey } = inferSpecialKeys(item);
  const profile = mergeProfile({ specialFeatureKey, specialCounterKey });

  const ident = norm(gp(item, "system.identifier"));
  const nm = norm(item?.name);
  const isDivineSpark = ident === "divinespark" || ident === "divine-spark" || /\bdivine\s*spark\b/.test(nm) || /\bchispa\s+divina\b/.test(nm);
  const isTollTheDead = ident === "tollthedead" || ident === "toll-the-dead" || /\btoll\s+the\s+dead\b/.test(nm) || /\bdoblar(?:e)?\s+los\s+muertos\b/.test(nm);
  const isGuidingBolt = ident === "guidingbolt" || ident === "guiding-bolt" || /\bguiding\s+bolt\b/.test(nm) || /\bsaeta\s+gu[ií]a\b/.test(nm);

  if (isDivineSpark) {
    profile.mode = "choice";
    profile.consume = "uses";
    return { profile, source: "legacy-name" };
  }
  if (isTollTheDead) {
    profile.mode = damageParts.length ? "damage" : "auto";
    profile.variants = {
      ...(profile.variants || {}),
      targetWoundedFirstPart: {
        enabled: true,
        from: "d8",
        to: "d12"
      }
    };
    profile.showSave = "always";
    return { profile, source: "legacy-name" };
  }
  if (isGuidingBolt) {
    profile.mode = damageParts.length ? "damage" : "auto";
    profile.showDescription = "show";
    profile.effectNoteTitle = "Impacto guiado";
    profile.effectNoteText = "Si impacta, la siguiente tirada de ataque contra este objetivo antes del final de tu próximo turno tiene ventaja.";
    return { profile, source: "legacy-name" };
  }

  if (bonusDie?.formula) {
    profile.mode = "bonusdie";
    profile.manualFormula = String(bonusDie.formula || "");
    profile.cardType = "bonusdie";
    return { profile, source: "inference" };
  }
  if (damageParts.length && healParts.length) {
    profile.mode = "choice";
    return { profile, source: "inference" };
  }
  if (damageParts.length) {
    profile.mode = "damage";
    return { profile, source: "inference" };
  }
  if (healParts.length) {
    profile.mode = "heal";
    return { profile, source: "inference" };
  }
  if (effectRoll?.formula) {
    profile.mode = "effectRoll";
    profile.manualFormula = String(effectRoll.formula || "");
    return { profile, source: "inference" };
  }

  const activities = getActivities(item);
  const hasSave = activities.some((a) => a?.type === "save" || a?.save);
  if (hasSave || safeNum(gp(item, "system.uses.max"), 0) > 0) {
    profile.mode = "effect";
    return { profile, source: "inference" };
  }

  return { profile, source: "inference" };
}

export function resolveActionProfile(item, actor = null) {
  const candidates = getItemProfileCandidates(item);
  const override = getItemActionProfileOverride(item);
  if (override) {
    return repairKnownMisclassifiedProfile(item, actor, { profile: override, source: "item-override", matchKey: "item-override", candidates });
  }

  const reg = getGlobalActionProfiles();
  for (const candidate of candidates) {
    const profile = reg?.[candidate.key];
    if (profile) return repairKnownMisclassifiedProfile(item, actor, { profile: mergeProfile(profile), source: "global-profile", matchKey: candidate.key, candidates });
  }

  const legacy = inferLegacyProfile(item, actor);
  return repairKnownMisclassifiedProfile(item, actor, { ...legacy, candidates });
}

export function shouldAutoApplyDamageOnFailedSave(profile) {
  return !!mergeProfile(profile || {}).autoApplyDamageOnFailedSave;
}

export function shouldAutoApplyStatusOnFailedSave(profile) {
  const merged = mergeProfile(profile || {});
  return !!(merged.autoApplyStatusOnFailedSave && String(merged.saveFailStatusId || "").trim());
}

export function getFailedSaveStatusId(profile) {
  const merged = mergeProfile(profile || {});
  if (!merged.autoApplyStatusOnFailedSave) return "";
  return String(merged.saveFailStatusId || "").trim();
}

function _buildActivityPartFormula(part, dieIncrease = 0) {
  const direct = String(gp(part, "formula") || "").trim();
  if (direct) return direct;
  if (gp(part, "custom.enabled") && gp(part, "custom.formula")) {
    const custom = String(gp(part, "custom.formula") || "").trim();
    if (!custom) return "";
    if (!dieIncrease) return custom;
    return custom.replace(/^(\d+)d/i, (match, num) => `${Number(num) + dieIncrease}d`);
  }
  const number = safeNum(gp(part, "number"), 0) + safeNum(dieIncrease, 0);
  const denomination = safeNum(gp(part, "denomination"), 0);
  const bonus = String(gp(part, "bonus") || "").trim();
  let base = number && denomination ? `${number}d${denomination}` : "";
  if (bonus && bonus !== "0") base = base ? `${base} + (${bonus})` : bonus;
  return base;
}

function _getItemBaseSpellLevel(item) {
  const raw = gp(item, "system.level");
  if (Number.isFinite(Number(raw))) return safeNum(raw, 0);
  if (raw && typeof raw === "object") return safeNum(raw.value ?? raw.level ?? raw.base ?? 0, 0);
  return 0;
}

function _applyActivityPartScaling(part, item, upcastLevel = 0) {
  const baseFormula = _buildActivityPartFormula(part, 0);
  const baseLevel = _getItemBaseSpellLevel(item);
  const steps = (item?.type === "spell" && safeNum(upcastLevel, 0) > baseLevel) ? (safeNum(upcastLevel, 0) - baseLevel) : 0;
  if (!steps) return { formula: baseFormula, isScaled: false };

  const mode = String(gp(part, "scaling.mode") || "").toLowerCase();
  let effSteps = steps;
  if (mode === "half") effSteps = Math.floor(effSteps * 0.5);
  else if (mode && mode !== "whole") effSteps = 0;
  if (!effSteps) return { formula: baseFormula, isScaled: false };

  const diePerStep = safeNum(gp(part, "scaling.number"), 1);
  const dieIncrease = diePerStep * effSteps;
  let formula = _buildActivityPartFormula(part, dieIncrease);

  const scalingFormula = String(gp(part, "scaling.formula") || "").trim();
  if (scalingFormula) {
    try {
      let roll = new Roll(scalingFormula);
      roll = roll.alter(effSteps, 0, { multiplyNumeric: true });
      formula = formula ? `${formula} + ${roll.formula}` : String(roll.formula || "").trim();
    } catch {
      formula = formula ? `${formula} + ((${scalingFormula}) * ${effSteps})` : `((${scalingFormula}) * ${effSteps})`;
    }
  }

  return { formula, isScaled: String(formula || "") !== String(baseFormula || "") };
}

function extractActivityParts(item, activityId, mode = "damage", { upcastLevel = 0 } = {}) {
  const act = getActivities(item).find((a) => String(a?.id || a?._id || "") === String(activityId || ""));
  if (!act) return [];
  const out = [];
  const rawParts = mode === "healing"
    ? (gp(act, "healing.parts") ?? gp(act, "heal.parts") ?? [])
    : (gp(act, "damage.parts") ?? []);

  for (const p of rawParts || []) {
    if (Array.isArray(p)) {
      const formula = String(p[0] || "").trim();
      if (formula) out.push({ formula, type: String(p[1] || (mode === "healing" ? "healing" : "damage")), label: "Actividad" });
      continue;
    }
    if (!p || typeof p !== "object") continue;
    const scaled = _applyActivityPartScaling(p, item, upcastLevel);
    const formula = String(scaled?.formula || "").trim() || _buildActivityPartFormula(p, 0);
    if (!formula) continue;
    out.push({
      formula,
      type: String(gp(p, "type") || gp(p, "damageType") || (mode === "healing" ? "healing" : "damage")),
      label: String(gp(p, "label") || act?.name || "Actividad"),
      isScaled: !!scaled?.isScaled
    });
  }
  return out;
}

function actorIsWounded(actor) {
  const value = safeNum(gp(actor, "system.attributes.hp.value"), 0);
  const max = safeNum(gp(actor, "system.attributes.hp.max"), 0);
  return max > 0 && value < max;
}

function applyVariants(parts, profile, targets = []) {
  const notes = [];
  let out = clone(parts || []);
  const tollVariant = gp(profile, "variants.targetWoundedFirstPart");
  if (tollVariant?.enabled && out.length) {
    const wounded = targets.filter((t) => actorIsWounded(t.actor));
    const full = targets.filter((t) => !actorIsWounded(t.actor));
    const shouldSwap = targets.length === 1 ? wounded.length === 1 : (targets.length > 0 && full.length === 0);
    const from = String(tollVariant.from || "d8").trim();
    const to = String(tollVariant.to || "d12").trim();
    const wantedDie = shouldSwap ? to : from;

    const escapeRe = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dieRegex = (die) => new RegExp(`(?:\\b\\d+${escapeRe(die)}\\b|\\b${escapeRe(die)}\\b)`, "i");

    if (out.length > 1) {
      const wantedMatch = out.find((part) => dieRegex(wantedDie).test(String(part?.formula || "")));
      if (wantedMatch) {
        out = [clone(wantedMatch)];
      } else {
        out = [clone(out[0])];
        if (shouldSwap) {
          out[0].formula = String(out[0].formula || "").replace(new RegExp(escapeRe(from), "ig"), to);
        }
      }
    } else if (shouldSwap) {
      out[0].formula = String(out[0].formula || "").replace(new RegExp(escapeRe(from), "ig"), to);
    }

    if (targets.length > 1 && wounded.length && full.length) {
      notes.push("Hay objetivos heridos y sanos a la vez; la acción usa el perfil base. Si quieres aplicar la variante solo a los heridos, resuélvelo por separado.");
    }
  }
  return { parts: out, notes };
}

export function getActionExecutionPlan({ actor, item, profile = null, targets = [], choiceMode = "", castLevel = 0 } = {}) {
  const resolved = profile ? { profile: mergeProfile(profile), source: "provided" } : resolveActionProfile(item, actor);
  const p = resolved.profile;
  const mode = String(choiceMode || p.mode || "auto").toLowerCase();

  const resolvedCastLevel = safeNum(castLevel, _getItemBaseSpellLevel(item));
  const damagePartsAuto = () => getDamagePartsDetailed(item, { actor, upcastLevel: resolvedCastLevel }) || [];
  const healPartsAuto = () => getHealingPartsDetailed(item, { actor, upcastLevel: resolvedCastLevel }) || [];
  const manualFormula = sanitizeFormulaLoose(p.manualFormula || "");

  const getPartsBySource = (kind = "damage") => {
    if (p.rollSource === "manual" && manualFormula) {
      return [{ formula: manualFormula, type: p.manualType || (kind === "healing" ? "healing" : "force"), label: item?.name || "Manual" }];
    }
    if (p.rollSource === "activity" && p.activityId) {
      return extractActivityParts(item, p.activityId, kind, { upcastLevel: resolvedCastLevel });
    }
    if (p.rollSource === "damage") return damagePartsAuto();
    if (p.rollSource === "healing") return healPartsAuto();
    if (p.rollSource === "none") return [];
    return kind === "healing" ? healPartsAuto() : damagePartsAuto();
  };

  let cardKind = "effect";
  let rollParts = [];
  let bonusDie = null;

  switch (mode) {
    case "damage":
      cardKind = p.cardType !== "auto" ? p.cardType : "damage";
      rollParts = getPartsBySource("damage");
      break;
    case "heal":
      cardKind = p.cardType !== "auto" ? p.cardType : "heal";
      rollParts = getPartsBySource("healing");
      break;
    case "choice": {
      const branch = String(choiceMode || "").toLowerCase();
      if (branch === "heal") {
        cardKind = "heal";
        rollParts = getPartsBySource("healing");
      } else if (branch === "damage") {
        cardKind = "damage";
        rollParts = getPartsBySource("damage");
      } else {
        cardKind = "choice";
      }
      break;
    }
    case "effectroll": {
      cardKind = p.cardType !== "auto" ? p.cardType : "effectRoll";
      if (manualFormula) rollParts = [{ formula: manualFormula, type: "effect", label: item?.name || "Efecto" }];
      else {
        const auto = inferAutoEffectRoll(item);
        if (auto?.formula) rollParts = [{ formula: String(auto.formula), type: "effect", label: String(auto.label || item?.name || "Efecto") }];
      }
      break;
    }
    case "bonusdie": {
      cardKind = "bonusdie";
      if (manualFormula) bonusDie = { formula: manualFormula, label: item?.name || "Bono" };
      else bonusDie = inferBonusDie(item, actor);
      break;
    }
    case "workflow":
      cardKind = "effect";
      break;
    case "hidden":
    case "effect":
      cardKind = p.cardType !== "auto" ? p.cardType : "effect";
      break;
    case "auto":
    default: {
      const d = damagePartsAuto();
      const h = healPartsAuto();
      if (d.length && h.length) {
        cardKind = "choice";
      } else if (d.length) {
        cardKind = "damage";
        rollParts = d;
      } else if (h.length) {
        cardKind = "heal";
        rollParts = h;
      } else {
        const autoEffect = inferAutoEffectRoll(item);
        const autoBonus = inferBonusDie(item, actor);
        if (autoEffect?.formula) {
          cardKind = "effectRoll";
          rollParts = [{ formula: String(autoEffect.formula), type: "effect", label: String(autoEffect.label || item?.name || "Efecto") }];
        } else if (autoBonus?.formula) {
          cardKind = "bonusdie";
          bonusDie = autoBonus;
        } else {
          cardKind = "effect";
        }
      }
      break;
    }
  }

  const variantRes = (cardKind === "damage" && rollParts.length) ? applyVariants(rollParts, p, targets) : { parts: rollParts, notes: [] };
  rollParts = variantRes.parts || rollParts;

  const showSaves = p.showSave === "always" ? true : p.showSave === "never" ? false : undefined;
  const showDescription = p.showDescription === "show" ? true : p.showDescription === "hide" ? false : undefined;

  return {
    resolved,
    profile: p,
    cardKind,
    rollParts,
    bonusDie,
    specialNotes: variantRes.notes || [],
    showSaves,
    showDescription,
    effectNote: (String(p.effectNoteTitle || "").trim() || String(p.effectNoteText || "").trim()) ? {
      title: String(p.effectNoteTitle || "").trim() || "Recordatorio",
      text: String(p.effectNoteText || "").trim()
    } : null
  };
}

export function shouldConsumeItemUseForProfile(profile, choiceMode = "") {
  const p = mergeProfile(profile || {});
  let mode = p.consume;
  if (p.consume === "choice") {
    mode = String(choiceMode || "").toLowerCase() === "heal" ? p.choiceConsumeHeal : p.choiceConsumeDamage;
  }
  if (mode === "auto") return undefined;
  return ["uses", "both"].includes(String(mode || ""));
}

export function shouldConsumeSpellSlotForProfile(profile, choiceMode = "") {
  const p = mergeProfile(profile || {});
  let mode = p.consume;
  if (p.consume === "choice") {
    mode = String(choiceMode || "").toLowerCase() === "heal" ? p.choiceConsumeHeal : p.choiceConsumeDamage;
  }
  if (mode === "auto") return undefined;
  return ["slot", "both"].includes(String(mode || ""));
}

export function isItemHiddenByProfile(item, actor = null) {
  const resolved = resolveActionProfile(item, actor);
  return !!resolved?.profile?.hidden || String(resolved?.profile?.mode || "") === "hidden";
}

export function buildProfileCatalogEntries() {
  const items = [];
  for (const it of game.items?.contents || []) items.push({ item: it, actorName: "Mundo" });
  for (const actor of game.actors?.contents || []) {
    for (const it of actor.items?.contents || actor.items || []) {
      items.push({ item: it, actorName: actor.name || "Actor" });
    }
  }

  const seen = new Set();
  const out = [];
  for (const { item, actorName } of items) {
    const candidates = getItemProfileCandidates(item);
    const primary = candidates[0]?.key || `legacyName:${normalizeName(item?.name)}`;
    const dedupeKey = primary || `${item.type}:${normalizeName(item?.name)}`;
    if (seen.has(`${dedupeKey}:${item.type}`)) continue;
    seen.add(`${dedupeKey}:${item.type}`);

    const resolved = resolveActionProfile(item, item?.parent || null);
    out.push({
      uid: dedupeKey,
      itemName: item.name || "(Sin nombre)",
      itemType: item.type || "item",
      identifier: String(gp(item, "system.identifier") || ""),
      actorName,
      itemUuid: item.uuid || null,
      primaryKey: primary,
      candidates,
      resolvedSource: resolved.source,
      resolvedMode: resolved.profile?.mode || "auto",
      hasOverride: !!getItemActionProfileOverride(item),
      hidden: !!resolved.profile?.hidden || resolved.profile?.mode === "hidden",
      defaultProfile: resolved.profile,
      matchKey: resolved.matchKey || primary,
      img: item.img || "icons/svg/mystery-man.svg"
    });
  }

  return out.sort((a, b) => a.itemName.localeCompare(b.itemName, "es") || a.itemType.localeCompare(b.itemType, "es"));
}
