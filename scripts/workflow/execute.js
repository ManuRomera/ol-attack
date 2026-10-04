import { SOCKET_NS } from "../shared/constants.js";
import { flagsTarjeta } from "../lib/flags.js";
import { gp, safeNum, escapeHtml, cleanDiceBonus, translateDamageType, sanitizeFormulaLoose } from "../lib/utils.js";
import { getProfBonus, autoAbilityForItem, getActorDamageBonusFormula } from "../lib/actor.js";
import { getExhaustionInfo } from "../lib/exhaustion.js";
import { getDamagePartsDetailed, getHealingPartsDetailed, inferHpGrantParts } from "../lib/damage.js";
import { getItemUses, consumeItemUse } from "../lib/uses.js";
import { inferBonusDie, inferAutoEffectRoll } from "../lib/trait-infer.js";
import { getSavesFromItem, buildSaveDefs, renderSavesHtml, getSaveSuccessDamageMode } from "../lib/saves.js";
import { getItemTags } from "../lib/tags.js";
import { getAttackBypassTags } from "../lib/riv.js";
import { addPendingDamageLines } from "../lib/damage-ledger.js";
import { prepareRoll } from "./rolls.js";
import { resolveActionProfile, getActionExecutionPlan, getWorkflowConfigFromProfile, validateActionConfigJson, mergeProfile } from "../lib/action-profiles.js";
import { setStatusOnSubject } from "../lib/statuses.js";
import { olChoose } from "../ui/dialogs.js";
import { getActorHpData, getActorAbilityMod, getActorProfValue } from "../shared/system-data.js";




// ---------- Tarjetas de chat ----------
// Todo el aspecto vive en styles/ol-attack.css (clases `ol-chat-*`), de modo que respeta el tema
// claro/oscuro del chat y el modo de alto contraste en lugar de llevar colores en línea.
const tt = (key, data) => game.i18n.format(key, data ?? {});

function chatHead({ img, title, tags = [] }) {
  return `<header class="ol-chat-head">
      <img class="ol-chat-img" src="${escapeHtml(img || "icons/svg/mystery-man.svg")}" alt="">
      <div class="ol-chat-title"><h3>${escapeHtml(title)}</h3>${tags.length ? `<div class="ol-chat-tags">${tags.map((tag) => `<span class="ol-tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}</div>
    </header>`;
}

function chatTargets(targets = []) {
  return targets.length ? `<div class="ol-chat-targets">${targets.map((tg) => `<span class="ol-chat-target"><i class="fa-solid fa-crosshairs"></i> ${escapeHtml(tg.name)}</span>`).join("")}</div>` : "";
}

function _slugifyItemIdentity(item) {
  const name = String(item?.name || "").toLowerCase().trim();
  const ident = String(gp(item, "system.identifier") || "").toLowerCase().trim();
  return { name, ident };
}

export function isDivineSparkItem(item) {
  const { name, ident } = _slugifyItemIdentity(item);
  return ident === "divineSpark".toLowerCase() || ident === "divine-spark" || /\bdivine\s*spark\b/i.test(name) || /\bchispa\s+divina\b/i.test(name);
}

function isTollTheDeadItem(item) {
  const { name, ident } = _slugifyItemIdentity(item);
  return ident === "tollTheDead".toLowerCase() || ident === "toll-the-dead" || /\btoll\s+the\s+dead\b/i.test(name) || /\bdoblar(?:e)?\s+los\s+muertos\b/i.test(name);
}

export function isChoiceModeItem(item, actor = null) {
  const resolved = resolveActionProfile(item, actor);
  return String(resolved?.profile?.mode || "").toLowerCase() === "choice";
}

function _isActorWounded(actor) {
  const hp = getActorHpData(actor);
  const value = safeNum(hp.value, 0);
  const max = safeNum(hp.max, 0);
  return max > 0 && value < max;
}

function _applyTollTheDeadRules(item, parts, targets = []) {
  if (!isTollTheDeadItem(item) || !Array.isArray(parts) || !parts.length) return { parts, note: "" };
  const wounded = targets.filter((t) => _isActorWounded(t.actor));
  const full = targets.filter((t) => !_isActorWounded(t.actor));
  const shouldUseD12 = targets.length === 1 ? wounded.length === 1 : (targets.length > 0 && full.length === 0);
  const out = foundry.utils.deepClone(parts);
  if (shouldUseD12) {
    out[0].formula = String(out[0].formula || "").replace(/(\d+)d8\b/gi, "$1d12");
  }
  const note = (targets.length > 1 && wounded.length && full.length)
    ? "Toll the Dead: hay objetivos heridos y sanos a la vez; la carta usa el perfil base. Si quieres aplicar d12 a los heridos, resuélvelo por separado."
    : "";
  return { parts: out, note };
}

async function _resolveRunTargets(explicitTargetUuids = []) {
  if (!Array.isArray(explicitTargetUuids) || !explicitTargetUuids.length) {
    return Array.from(game.user?.targets ?? []);
  }
  const out = [];
  for (const uuid of explicitTargetUuids) {
    const doc = await fromUuid(uuid).catch(() => null);
    const actor = doc?.actor || (doc?.documentName === "Actor" ? doc : null);
    if (!actor) continue;
    out.push({ document: doc?.documentName === "Token" ? doc : doc, actor, name: doc?.name || actor.name || "Objetivo" });
  }
  return out;
}

export function getChoiceModeRollParts({ actor, item, mode = "damage", targets = [], profile = null, spellLevel = 0 } = {}) {
  const plan = getActionExecutionPlan({ actor, item, profile, targets, choiceMode: mode, castLevel: spellLevel });
  if (plan?.rollParts?.length) return plan.rollParts;
  const ability = autoAbilityForItem(item, actor) || "wis";
  const fallbackFormula = `1d8 + @abilities.${ability}.mod`;
  if (mode === "heal") return [{ formula: fallbackFormula, type: "healing", label: "Curar" }];
  return [{ formula: fallbackFormula, type: "radiant", label: "Dañar" }];
}

export function getDivineSparkRollParts({ actor, item, mode = "damage", spellLevel = 0 } = {}) {
  return getChoiceModeRollParts({ actor, item, mode, targets: [], spellLevel });
}

export async function postChoiceModeCard({ actor, token, item, targetUuids = [], profile = null, spellLevel = 0, slotKey = null, consumeSlot = false } = {}) {
  const targetDocs = await _resolveRunTargets(targetUuids);
  const targetsMeta = targetDocs.map((t) => ({ tokenUuid: t.document?.uuid || null, actorUuid: t.actor?.uuid || null, name: t.name }));
  const itemName = item?.name || "Chispa divina";
  const content = `
  <div class="ol-chat" data-kind="choice">
    ${chatHead({ img: item?.img, title: itemName })}
    <div class="ol-chat-body">
      <p class="ol-chat-prompt">${tt("OLATTACK.Chat.ChoosePrompt", { name: escapeHtml(itemName) })}</p>
      ${chatTargets(targetDocs)}
    </div>
    <footer class="ol-chat-buttons ol-choice-buttons">
      <button type="button" class="ol-divine-spark-choice" data-choice="heal"><i class="fa-solid fa-heart-pulse"></i> ${tt("OLATTACK.Chat.Heal")}</button>
      <button type="button" class="ol-divine-spark-choice" data-choice="damage"><i class="fa-solid fa-burst"></i> ${tt("OLATTACK.Chat.Damage")}</button>
    </footer>
  </div>`;

  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor, token }),
    content,
    flags: flagsTarjeta({
          specialAction: "choiceMode",
          specialResolved: false,
          actorUuid: actor?.uuid || null,
          tokenUuid: token?.document?.uuid || token?.uuid || null,
          itemId: item?.id || null,
          itemUuid: item?.uuid || null,
          targets: Array.isArray(targetUuids) ? targetUuids : [],
          targetsMeta,
          itemName: item?.name || "Chispa divina",
          spellLevel: Number(spellLevel || 0),
          slotKey: slotKey || null,
          consumeSlot: !!consumeSlot,
          systemMode: "normal",
          attackTags: [],
          templateUuid: null,
          saveDefs: [],
          saveTrack: {},
          actionProfile: profile || resolveActionProfile(item, actor)?.profile || null
        })
  });
}


export async function postDivineSparkChoiceCard(args = {}) {
  return postChoiceModeCard(args);
}


async function _chooseWorkflowTarget({ step, actor, token, availableTargets = [], workflowDefault = "selected" } = {}) {
  const targeting = String(step?.targeting || workflowDefault || "selected").trim();
  if (targeting === "none") return [];
  if (targeting === "self") {
    const tokenDoc = token?.document || token || null;
    return [{ document: tokenDoc, actor, name: tokenDoc?.name || actor?.name || "Self" }].filter((t) => t.actor);
  }
  if (targeting === "targetIndex") {
    const idx = Math.max(0, Number(step?.targetIndex || 0));
    return availableTargets[idx] ? [availableTargets[idx]] : [];
  }
  if (targeting !== "chooseOne") return availableTargets;
  if (!availableTargets.length) return [];
  if (availableTargets.length === 1) return [availableTargets[0]];

  const key = await olChoose({
    title: `Elegir objetivo · ${step?.label || actor?.name || "OL Attack"}`,
    intro: `Elige a qué objetivo aplicar <b>${escapeHtml(step?.label || actor?.name || "la acción")}</b>.`,
    options: availableTargets.map((tg, index) => ({ key: index, label: tg?.name || `Objetivo ${index + 1}`, img: tg?.document?.texture?.src || tg?.actor?.img }))
  });
  const picked = key === null ? null : availableTargets[Number(key)];
  return picked ? [picked] : [];
}

async function _postWorkflowEffectCard({ actor, token, item, step, targetDocs = [] } = {}) {
  const title = step?.label || item?.name || "Efecto";
  const text = String(step?.description || "").trim() || "Sin descripción.";
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor, token }),
    content: `
      <div class="ol-chat" data-kind="effect">
        ${chatHead({ img: item?.img, title })}
        <div class="ol-chat-body">
          <p class="ol-chat-text">${escapeHtml(text).replace(/\n/g, "<br>")}</p>
          ${chatTargets(targetDocs)}
        </div>
      </div>`
  });
}

async function _chooseWorkflowBranch(step = {}) {
  const entries = Object.entries(step?.branches || {});
  if (!entries.length) return null;
  if (entries.length === 1) return entries[0][0];
  return olChoose({
    title: `Elegir modo · ${step?.label || 'Acción'}`,
    intro: escapeHtml(step?.description || `Elige cómo resolver ${step?.label || 'la acción'}.`),
    options: entries.map(([key, branch]) => ({ key, label: branch?.label || key, hint: branch?.description || "" })),
    width: 460
  });
}

async function _executeWorkflowSteps({ actor, token, item, opts, availableTargets = [], steps = [], workflowDefaultTargeting = 'selected' } = {}) {
  const results = [];
  for (const step of Array.from(steps || [])) {
    const repeat = Math.max(1, Number(step?.repeat || 1));
    for (let repeatIndex = 0; repeatIndex < repeat; repeatIndex += 1) {
      const stepTargets = await _chooseWorkflowTarget({ step, actor, token, availableTargets, workflowDefault: workflowDefaultTargeting });
      const targetUuids = stepTargets.map((t) => t?.document?.uuid).filter(Boolean);
      const label = repeat > 1 ? `${step?.label || item?.name || 'Acción'} ${repeatIndex + 1}` : (step?.label || item?.name || 'Acción');
      if (step?.type === 'damageRoll' || step?.type === 'healRoll') {
        const tempProfile = mergeProfile({ mode: step.type === 'healRoll' ? 'heal' : 'damage', rollSource: 'manual', manualFormula: String(step?.formula || ''), manualType: String(step?.damageType || (step.type === 'healRoll' ? 'healing' : 'force')), cardType: step.type === 'healRoll' ? 'heal' : 'damage', consume: 'none', showDescription: 'hide', jsonConfig: null, variants: {} });
        const rollParts = [{ formula: String(step?.formula || ''), type: String(step?.damageType || (step.type === 'healRoll' ? 'healing' : 'force')), label }];
        results.push(await runAction({ actor, token, item, opts: { ...opts, targetUuids, itemName: label, rollTitle: label, forceCardKind: step.type === 'healRoll' ? 'heal' : 'damage', overrideRollParts: rollParts, resolvedActionProfile: tempProfile, showDescription: false } }));
        continue;
      }
      if (step?.type === 'bonusDie') {
        const tempProfile = mergeProfile({ mode: 'bonusdie', rollSource: 'manual', manualFormula: String(step?.formula || ''), cardType: 'bonusdie', consume: 'none', showDescription: 'hide', jsonConfig: null, variants: {} });
        results.push(await runAction({ actor, token, item, opts: { ...opts, targetUuids, itemName: label, rollTitle: label, resolvedActionProfile: tempProfile, forceCardKind: 'bonusdie', showDescription: false } }));
        continue;
      }
      if (step?.type === 'effectText') {
        results.push(await _postWorkflowEffectCard({ actor, token, item, step: { ...step, label }, targetDocs: stepTargets }));
        continue;
      }
      if (step?.type === 'applyStatus' || step?.type === 'removeStatus') {
        const active = step.type === 'applyStatus';
        const applied = [];
        for (const target of stepTargets) {
          const res = await setStatusOnSubject({ actor: target?.actor, token: target?.document, statusId: step?.statusId, active });
          if (res?.ok) applied.push(target?.name || target?.actor?.name || res.label);
        }
        results.push(await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor, token }),
          content: `<div class="ol-chat" data-kind="status"><div class="ol-chat-body"><h3 class="ol-chat-h">${escapeHtml(label)}</h3><p class="ol-chat-text">${escapeHtml(active ? tt("OLATTACK.Chat.StatusApplied") : tt("OLATTACK.Chat.StatusRemoved"))}: <b>${escapeHtml(String(step?.statusId || ''))}</b>${applied.length ? ` → ${escapeHtml(applied.join(', '))}` : ''}</p></div></div>`
        }));
        continue;
      }
      if (step?.type === 'choice') {
        const branchKey = await _chooseWorkflowBranch(step);
        if (!branchKey || !step?.branches?.[branchKey]) continue;
        results.push(...(await _executeWorkflowSteps({ actor, token, item, opts, availableTargets, steps: step.branches[branchKey].steps || [], workflowDefaultTargeting: workflowDefaultTargeting })));
      }
    }
  }
  return results;
}

async function _runWorkflowAction({ actor, token, item, opts = {}, resolvedActionProfile = null, targets = [] } = {}) {
  const workflowConfig = getWorkflowConfigFromProfile(resolvedActionProfile?.profile || {});
  const check = validateActionConfigJson(workflowConfig || {}, resolvedActionProfile?.profile || {});
  if (!check.ok) {
    ui.notifications.error(`JSON de acción inválido en ${item?.name || 'OL Attack'}: ${check.errors.join(' | ')}`);
    return null;
  }
  const wf = check.normalized?.workflow || workflowConfig?.workflow;
  if (!wf?.steps?.length) {
    ui.notifications.warn(`El JSON de acción de ${item?.name || 'OL Attack'} no tiene pasos.`);
    return null;
  }
  return _executeWorkflowSteps({ actor, token, item, opts, availableTargets: targets, steps: wf.steps, workflowDefaultTargeting: wf?.targeting?.default || 'selected' });
}


function isSavageAttackerEligible(item) {
  if (!item) return false;
  if (item.type === "weapon") return true;
  const at = String(gp(item, "system.actionType") || "").toLowerCase();
  return at.includes("mwak") || at.includes("rwak") || at.includes("wak");
}

function augmentRoll(baseRoll, adds = []) {
  try {
    const data = baseRoll.toJSON();
    data.terms = foundry.utils.deepClone(data.terms);
    let total = safeNum(baseRoll.total, 0);
    let formula = String(baseRoll.formula || "");

    for (const n0 of adds) {
      const n = Number(n0);
      if (!Number.isFinite(n) || n === 0) continue;
      const op = n >= 0 ? "+" : "-";
      const abs = Math.abs(n);
      total += n;
      formula = `${formula} ${op} ${abs}`;
      data.terms.push({ class: "OperatorTerm", operator: op }, { class: "NumericTerm", number: abs });
    }

    data.formula = formula;
    data.total = total;
    const adjusted = Roll.fromData ? Roll.fromData(data) : Roll.fromJSON(JSON.stringify(data));
    adjusted._evaluated = true;
    adjusted._total = total;
    adjusted._formula = formula;
    return adjusted;
  } catch {
    // fallback: mutar el roll original
    baseRoll._total = safeNum(baseRoll.total, 0) + adds.reduce((a, n) => a + safeNum(n, 0), 0);
    baseRoll._formula = `${baseRoll.formula} + ${adds.filter((n) => safeNum(n, 0)).join(" + ")}`;
    return baseRoll;
  }
}

export async function runAction({ actor, token, item, opts }) {
  const targets = await _resolveRunTargets(opts?.targetUuids || []);
  const targetsMeta = targets.map((t) => ({ tokenUuid: t.document?.uuid || null, actorUuid: t.actor?.uuid || null, name: t.name }));

  // Roll data: necesario para resolver @mod/@prof en D&D5e (Heroism, Cure Wounds, etc.)
  const rollData = (item && typeof item.getRollData === "function")
    ? item.getRollData()
    : (typeof actor.getRollData === "function" ? actor.getRollData() : {});

  // normalize @mod / @prof for spells & healing formulas (Heroism, Cure Wounds, etc.)
  if (item?.type === "spell") {
    const spellAb = autoAbilityForItem(item, actor);
    if (rollData.mod == null) rollData.mod = safeNum(getActorAbilityMod(actor, spellAb), 0);
    if (rollData.prof == null) rollData.prof = safeNum(getActorProfValue(actor), 0);
  }

  // RASGOS: dado adicional configurable por ítem.
  // Debe tirarse SIEMPRE que exista (independientemente del tipo de tarjeta) y mostrarse en el chat.
  // Si el ítem no tiene tirada propia (EFECTO), este dado puede actuar como "tirada principal".
  const traitExtraRoll = (() => {
    const f0 = String(opts?.effectExtraDiceFormula || "").trim();
    if (!f0) return null;
    const f = sanitizeFormulaLoose(f0);
    if (!f) return null;
    const lbl = String(opts?.effectExtraDiceLabel || "").trim() || "Dados extra";
    return { formula: f, label: lbl };
  })();
  let traitExtraPrimary = false;

  const isOffhand = !!opts.isOffhand;
  const isHomebrew = opts.systemMode === "homebrew";
  // Seguridad: Ataque Temerario / Reckless debe forzar ventaja aunque el caller no haya pasado mode.
  const mode = opts.applyReckless ? "adv" : (opts.mode ?? "normal");

  // Ability used to derive the ability modifier (Homebrew damage only).
// opts.ability = "none" disables adding any ability modifier.
let ab = null;
if (isOffhand) ab = "dex";
else if (opts.ability === "none") ab = null;
else if (opts.ability === "auto") ab = autoAbilityForItem(item, actor);
else ab = opts.ability;

const mod = ab ? safeNum(getActorAbilityMod(actor, ab), 0) : 0;
  const prof = opts.prof ? getProfBonus(actor) : 0;
  const temp = safeNum(opts.temp, 0);
  const ex = getExhaustionInfo(actor);
  const exhaustionPenalty = ex.penalty;

  // Bonos/penalizadores de daño del actor (derivados de estados/ActiveEffects)
  // En Homebrew solo aplicamos los que sean claramente numéricos para evitar mezclar daños de tipo distinto.
  let actorDmgBonusRaw = "";
  let actorDmgBonusSafe = "";
  if (isHomebrew && !isOffhand && item && !opts.disableActorDamageBonuses) {
    actorDmgBonusRaw = String(getActorDamageBonusFormula(actor, item) || "").trim();
    // Solo expresiones numéricas sencillas (p.ej. -2, +3, (2), 1+2, etc.)
    // Si contiene dados (@, d6, etc.) lo ignoramos aquí.
    if (actorDmgBonusRaw && /^[0-9+\-*/().\s]+$/.test(actorDmgBonusRaw)) actorDmgBonusSafe = actorDmgBonusRaw;
  }

  const resolvedActionProfile = (!isOffhand && item)
    ? (opts?.resolvedActionProfile ? { profile: opts.resolvedActionProfile, source: "passed" } : resolveActionProfile(item, actor))
    : null;
  const manualDamageMode = !isOffhand && opts.dmgMode === "manual";
  const profilePlan = (!isOffhand && item && !manualDamageMode)
    ? getActionExecutionPlan({ actor, item, profile: resolvedActionProfile?.profile || null, targets, choiceMode: opts?.choiceMode || "", castLevel: safeNum(opts?.spellLevel, safeNum(item?.system?.level, 0)) })
    : null;

  const workflowConfig = (!isOffhand && item && !manualDamageMode) ? getWorkflowConfigFromProfile(resolvedActionProfile?.profile || {}) : null;
  if (workflowConfig?.workflow?.steps?.length) {
    return _runWorkflowAction({ actor, token, item, opts, resolvedActionProfile, targets });
  }

  // Partes
  let parts = [];
  let healParts = [];

  if (isOffhand) {
    parts = [{ formula: String(opts.offhandFormula || "1d6"), type: String(opts.offhandDamageType || "bludgeoning"), label: "Mano Débil" }];
  } else {
    const castLevel = safeNum(opts.spellLevel, safeNum(item?.system?.level, 0));
    parts = manualDamageMode
      ? [{ formula: sanitizeFormulaLoose(opts.manualFormula || "0") || "0", type: String(opts.manualType || "bludgeoning"), label: "Manual" }]
      : getDamagePartsDetailed(item, { abilityMod: mod, upcastLevel: castLevel, actor });
    healParts = getHealingPartsDetailed(item, { upcastLevel: castLevel, actor });
  }

  if (Array.isArray(opts?.overrideRollParts) && opts.overrideRollParts.length) {
    if (opts.forceCardKind === "heal") { healParts = foundry.utils.deepClone(opts.overrideRollParts); parts = []; }
    else { parts = foundry.utils.deepClone(opts.overrideRollParts); if (opts.forceCardKind === "damage") healParts = []; }
  }

  const specialNotes = [];
  let forcedBonusDieInfo = null;
  let effectNote = null;
  if (profilePlan?.specialNotes?.length) specialNotes.push(...profilePlan.specialNotes);
  if (profilePlan?.effectNote) effectNote = foundry.utils.deepClone(profilePlan.effectNote);
  if (profilePlan?.showSaves !== undefined) opts.showSaves = profilePlan.showSaves;
  if (profilePlan?.showDescription !== undefined) opts.showDescription = profilePlan.showDescription;
  if (profilePlan?.cardKind === "damage") {
    parts = foundry.utils.deepClone(profilePlan.rollParts || parts || []);
    healParts = [];
    opts.forceCardKind = "damage";
  } else if (profilePlan?.cardKind === "heal") {
    healParts = foundry.utils.deepClone(profilePlan.rollParts || healParts || []);
    parts = [];
    opts.forceCardKind = "heal";
  } else if (profilePlan?.cardKind === "effectRoll") {
    parts = foundry.utils.deepClone(profilePlan.rollParts || []);
    healParts = [];
    opts.forceCardKind = "effectRoll";
  } else if (profilePlan?.cardKind === "bonusdie") {
    parts = [];
    healParts = [];
    forcedBonusDieInfo = profilePlan.bonusDie || null;
    opts.forceCardKind = "bonusdie";
  } else if (profilePlan?.cardKind === "effect") {
    parts = [];
    healParts = [];
    opts.forceCardKind = "effect";
  }
  if (parts.length && !profilePlan?.specialNotes?.length && !gp(resolvedActionProfile?.profile, "variants.targetWoundedFirstPart.enabled")) {
    const adjusted = _applyTollTheDeadRules(item, parts, targets);
    parts = adjusted.parts;
    if (adjusted.note) specialNotes.push(adjusted.note);
  }

  const hasDamage = parts.length > 0;
  const hasHealing = healParts.length > 0;

  // Determinar tipo de tarjeta
  let cardKind = opts.forceCardKind || "damage";
  let rollParts = parts;
  if (!opts.forceCardKind) {
    if (!hasDamage && hasHealing) { cardKind = "heal"; rollParts = healParts; }
    if (!hasDamage && !hasHealing) { cardKind = "effect"; rollParts = [{ formula: "0", type: "effect" }]; }
  } else if (opts.forceCardKind === "heal") {
    rollParts = healParts;
  } else if (opts.forceCardKind === "damage" || opts.forceCardKind === "effectRoll") {
    rollParts = parts;
  } else if (opts.forceCardKind === "effect" || opts.forceCardKind === "bonusdie") {
    rollParts = [];
  }

  // HP boons (Temp HP / Temp Max HP) en conjuros/rasgos sin actividad de curación.
  // Ej: Aid, rasgos que "otorgan PG temporales" vía texto/AE.
  if (cardKind === "effect" && item && !opts.forceCardKind) {
    const castLevel = safeNum(opts.spellLevel, 0);
    const hpGrant = inferHpGrantParts(item, { castLevel });
    if (hpGrant?.parts?.length) {
      cardKind = "heal";
      rollParts = hpGrant.parts;
    }
  }

  // Rasgos especiales: auto-tirada (ej. Piel de piedra / Stone's Endurance) aunque no esté configurado en "Dados extra".
  // IMPORTANTE: esto debe evaluarse ANTES que los "bonus dice" (Bless/Inspiración),
  // porque algunos rasgos (Stone's Endurance) contienen "roll" + "add" y podrían ser mal clasificados como bonus.
  if (cardKind === "effect" && item && !opts.forceCardKind && !opts?.effectExtraDiceFormula) {
    const auto = inferAutoEffectRoll(item);
    if (auto?.formula) {
      cardKind = "effectRoll";
      rollParts = [{ formula: String(auto.formula), type: "effect", label: String(auto.label || "Efecto") }];
    }
  }

  // Bonus die (Bendición, Inspiración Bárdica, etc.): en lugar de "EFECTO" mostramos el dado que se añade.
  let bonusDieInfo = forcedBonusDieInfo || null;
  if (cardKind === "effect" && item && !opts.forceCardKind) {
    bonusDieInfo = inferBonusDie(item, actor);
    if (bonusDieInfo?.formula) {
      cardKind = "bonusdie";
    }
  }

  // Rasgos: si el ítem NO tiene tirada propia (EFECTO), el "dado adicional" actúa como tirada principal.
  if (cardKind === "effect" && traitExtraRoll?.formula) {
    cardKind = "effectRoll";
    rollParts = [{
      formula: String(traitExtraRoll.formula || "0"),
      type: "effect",
      label: traitExtraRoll.label || "Dados extra"
    }];
    traitExtraPrimary = true;
  }

// Extras (solo en daño)
  const extras = [];
  if (cardKind === "damage" && !isOffhand) {
    // Frenesí (Berserker) es fijo en esta macro: +2d6
    if (opts.applyFrenzy) extras.push({ formula: `2d6`, type: rollParts[0]?.type || "bludgeoning", label: "Frenesí" });
    if (opts.applySneak && opts.sneakFormula) extras.push({ formula: String(opts.sneakFormula), type: rollParts[0]?.type || "bludgeoning", label: "Ataque Furtivo" });
    if (opts.applyHex && opts.hexFormula) extras.push({ formula: String(opts.hexFormula), type: "necrotic", label: "Maldición" });
    if (opts.applyExtraDice && opts.extraDiceFormula) extras.push({ formula: String(opts.extraDiceFormula), type: rollParts[0]?.type || "bludgeoning", label: opts.extraDiceLabel || "Dados extra" });
  }
  rollParts = [...rollParts, ...extras];

  // ====== Tiradas + breakdown ======
  let total = 0;
  let breakdown = "";
  const appData = [];
  const dice3dPromises = [];

  // Bonus die: NO se tira. Se muestra el dado que el objetivo debe sumar.
  if (cardKind === "bonusdie" && bonusDieInfo?.formula) {
    const die = String(bonusDieInfo.formula);
    const lbl = String(bonusDieInfo.label || opts.itemName || opts.rollTitle || "Bono");
    breakdown = `
      <div class="ol-chat-row">
        <div class="ol-chat-line"><span><strong>${tt("OLATTACK.Chat.BonusDie")}</strong> <small>(${escapeHtml(lbl)})</small></span><b class="ol-chat-accent">${escapeHtml(die)}</b></div>
        <div class="ol-hidden-details">${tt("OLATTACK.Chat.BonusDieHint")}<br>${tt("OLATTACK.Chat.Die")}: <code>${escapeHtml(die)}</code></div>
      </div>`;
  } else {

  for (let i = 0; i < rollParts.length; i++) {
    const part = rollParts[i] || {};
    const baseF = String(part.formula || "0");
    let f = baseF;
    let sumMod = 0, sumProf = 0, sumTemp = 0, sumExh = 0, sumDef = 0;
    let bonusApplied = "";

    if (cardKind === "damage" && i === 0 && !isOffhand) {
      const allowAutoDamageAddons = opts.dmgMode !== "manual";
      if (isHomebrew) {
        const allowHomebrewAbilityMod = !(item?.type === "spell" && opts.ability === "auto");
        if (allowAutoDamageAddons && allowHomebrewAbilityMod && mod) { f += ` + ${mod}`; sumMod = mod; }
        if (allowAutoDamageAddons && prof) { f += ` + ${prof}`; sumProf = prof; }
        if (allowAutoDamageAddons && temp) { f += ` + ${temp}`; sumTemp = temp; }
        if (allowAutoDamageAddons && opts.applyRage) f += ` + ${safeNum(opts.rageBonus, 0)}`;
        if (allowAutoDamageAddons && ex.level > 0 && exhaustionPenalty > 0) { f += ` - ${exhaustionPenalty}`; sumExh = -exhaustionPenalty; }

        // Bonos/penalizadores de estados (si son numéricos)
        if (allowAutoDamageAddons && actorDmgBonusSafe) { f += ` + (${actorDmgBonusSafe})`; bonusApplied = actorDmgBonusSafe; }
      } else {
        if (allowAutoDamageAddons && temp) { f += ` + ${temp}`; sumTemp = temp; }
      }

      // Atacante Salvaje se gestiona como reroll del daño del arma (más abajo), no como sustitución de fórmula.
    } else if (cardKind !== "damage" && i === 0 && cardKind !== "effectRoll") {
      if (temp) { f += ` + ${temp}`; sumTemp = temp; }
    }

    // Atacante Salvaje (arma): tirar 2 veces los dados del arma y elegir el resultado.
    const savageActive = !!(opts.applySavage && cardKind === "damage" && i === 0 && !isOffhand && isSavageAttackerEligible(item));

    let chosen, other, allRolls;
    if (savageActive) {
      const doBase = async () => {
        const r = new Roll(baseF, rollData);
        await r.evaluate();
        return r;
      };
      const r1 = await doBase();
      const r2 = await doBase();
      const baseChosen = r1.total >= r2.total ? r1 : r2;
      const baseOther = baseChosen === r1 ? r2 : r1;
      allRolls = [r1, r2];

      // Valor numérico de bonusApplied (expresión sin dados)
      let bonusVal = 0;
      if (bonusApplied) {
        try {
          const br = new Roll(String(bonusApplied), rollData);
          await br.evaluate();
          bonusVal = safeNum(br.total, 0);
        } catch {}
      }

      const rageVal = (isHomebrew && opts.applyRage && opts.dmgMode !== "manual") ? safeNum(opts.rageBonus, 0) : 0;
      const adds = [sumMod, sumProf, sumTemp, rageVal, sumExh, bonusVal];

      chosen = augmentRoll(baseChosen, adds);
      other = augmentRoll(baseOther, adds);
    } else {
      ({ chosen, other, allRolls } = await prepareRoll(f, mode, rollData));
    }

    if (game.dice3d && allRolls) dice3dPromises.push(...allRolls.map((r) => game.dice3d.showForRoll(r, game.user, true)));
    else if (game.dice3d) dice3dPromises.push(game.dice3d.showForRoll(chosen, game.user, true));

    let rollTotal = chosen.total;

    total += rollTotal;
    appData.push({ amount: rollTotal, type: part.type || "bludgeoning", applyCurrent: !!part.applyCurrent, formula: chosen.formula || part.formula || "", label: part.label || "" });

    const diceResults = chosen.dice?.map((d) => `[${d.total}]`).join(" + ") || "";
    const labelTxt = part.label ? ` <small>(${escapeHtml(part.label)})</small>` : "";
    const totalAjustes = sumMod + sumProf + sumTemp + sumExh + sumDef;
    const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;

    breakdown += `
      <div class="ol-chat-row">
        <div class="ol-chat-line"><span><strong>${rollTotal}</strong> ${escapeHtml(translateDamageType(part.type))}${labelTxt}</span></div>
        <div class="ol-hidden-details">
          ${part.label ? `${tt("OLATTACK.Chat.Bonus")}: <b>${escapeHtml(part.label)}</b><br>` : ""}
          ${tt("OLATTACK.Chat.Formula")}: <code>${escapeHtml(chosen.formula)}</code><br>
          ${tt("OLATTACK.Chat.Dice")}: <span class="ol-chat-dice">${escapeHtml(diceResults)}</span> = <b>${chosen.total}</b>
          ${other ? `<br>${tt("OLATTACK.Chat.DoubleRoll")}: [${other.total}] vs [${chosen.total}]` : ""}
          ${ex.level > 0 && isHomebrew && i === 0 && cardKind === "damage" ? `<br>${tt("OLATTACK.Chat.Exhaustion", { level: ex.level, penalty: exhaustionPenalty })}` : ""}
          ${bonusApplied ? `<br>${tt("OLATTACK.Chat.StatesBonus")}: <code>${escapeHtml(bonusApplied)}</code>` : ""}
          ${part.isScaled ? `<br>${tt("OLATTACK.Chat.Upcast")}` : ""}
          <dl class="ol-chat-sums">
            <dt>${tt("OLATTACK.Chat.Base")}</dt><dd><code>${escapeHtml(String(part.formula || "0"))}</code></dd>
            <dt>Mod</dt><dd>${signed(sumMod)}</dd>
            <dt>Prof</dt><dd>${signed(sumProf)}</dd>
            <dt>Temp</dt><dd>${signed(sumTemp)}</dd>
            <dt>${tt("OLATTACK.Chat.ExhaustionShort")}</dt><dd>${signed(sumExh)}</dd>
            ${bonusApplied ? `<dt>${tt("OLATTACK.Chat.States")}</dt><dd><code>${escapeHtml(bonusApplied)}</code></dd>` : ""}
            <dt>${tt("OLATTACK.Chat.Defense")}</dt><dd>${signed(sumDef)}</dd>
            <dt>${tt("OLATTACK.Chat.TotalAdjust")}</dt><dd><b>${signed(totalAjustes)}</b></dd>
          </dl>
        </div>
      </div>`;
  }
  }

  // RASGOS: el "dado adicional" debe tirarse siempre y mostrarse junto a la tarjeta,
  // incluso cuando el ítem ya tenga su propia tirada (daño/curación/bonusdie/autoeffect).
  // NO modifica el total de daño/curación; es un resultado adicional informativo.
  if (traitExtraRoll && !traitExtraPrimary) {
    try {
      const r = new Roll(String(traitExtraRoll.formula), rollData);
      await r.evaluate();
      if (game.dice3d) {
        try { await game.dice3d.showForRoll(r, game.user, true); } catch {}
      }
      const diceResults = r.dice?.map((d) => `[${d.total}]`).join(" + ") || "";
      breakdown += `
        <div class="ol-chat-row ol-chat-extra">
          <div class="ol-chat-line"><span><strong><i class="fa-solid fa-dice"></i> ${escapeHtml(traitExtraRoll.label || tt("OLATTACK.Preview.ExtraDice"))}</strong></span><b class="ol-chat-accent">${escapeHtml(String(r.total))}</b></div>
          <div class="ol-hidden-details">
            ${tt("OLATTACK.Chat.Formula")}: <code>${escapeHtml(String(r.formula))}</code><br>
            ${tt("OLATTACK.Chat.Dice")}: <span class="ol-chat-dice">${escapeHtml(diceResults)}</span> = <b>${escapeHtml(String(r.total))}</b>
          </div>
        </div>`;
    } catch (e) {
      breakdown += `
        <div class="ol-chat-row ol-chat-error">
          <i class="fa-solid fa-triangle-exclamation"></i> ${tt("OLATTACK.Chat.ExtraDiceFailed")} (<code>${escapeHtml(String(e?.message || e))}</code>)
        </div>`;
    }
  }

  if (dice3dPromises.length) Promise.allSettled(dice3dPromises);

  // Saves
  const suppressSavesForItem = item && isTollTheDeadItem(item, actor) && profilePlan?.showSaves !== true;
  const saves = (opts.showSaves && item && !suppressSavesForItem) ? await getSavesFromItem(item, actor, { isHomebrew }) : [];
  const saveSuccessDamageMode = (cardKind === "damage" && saves.length) ? getSaveSuccessDamageMode(item) : "none";
  const saveDefs = buildSaveDefs({ rollTitle: opts.rollTitle, saves });
  const saveTrack = {};
  const savesHtml = saveDefs.length ? renderSavesHtml({ saveDefs, targetsMeta, saveTrack }) : "";

  const attackTags = Array.from(getAttackBypassTags(item));
  const tags = getItemTags(item, {
    rage: !!opts.applyRage,
    reckless: !!opts.applyReckless,
    frenzy: !!opts.applyFrenzy,
    sneak: !!opts.applySneak,
    savage: !!opts.applySavage,
    offhand: isOffhand,
    hex: !!opts.applyHex,
    extraDice: !!opts.applyExtraDice,
    isHomebrew,
    castLevel: opts.castLevelUp ? opts.spellLevel : null
  });

  const itemImg = opts.itemImg || item?.img || "icons/svg/sword.svg";
  const rollTitle = opts.rollTitle;

  const firstType = String(rollParts[0]?.type || "").toLowerCase();
  const isTempHp = firstType === "temphp" || firstType.includes("temp");
  const isTempMax = firstType === "tempmax";
  const centerLabel = cardKind === "damage"
    ? `<b>${total}</b> ${tt("OLATTACK.Chat.DamageWord")}`
    : cardKind === "heal"
      ? (isTempMax ? `<b>+${total}</b> ${tt("OLATTACK.Chat.TempMaxWord")}` : (isTempHp ? `<b>+${total}</b> ${tt("OLATTACK.Chat.TempHpWord")}` : `<b>+${total}</b> ${tt("OLATTACK.Chat.HealWord")}`))
      : cardKind === "bonusdie"
        ? `${tt("OLATTACK.Chat.Die")}: <b>${escapeHtml(String(bonusDieInfo?.formula || "").trim())}</b>`
        : cardKind === "effectRoll"
          ? `<b>${total}</b> ${(/reducci/i.test(String(rollParts[0]?.label||""))) ? tt("OLATTACK.Chat.ReductionWord") : tt("OLATTACK.Chat.EffectWord")}`
          : `<b>${tt("OLATTACK.Chat.EffectWord")}</b>`;

  const detailsBtn = `<button type="button" class="ol-toggle-details"><i class="fa-solid fa-list"></i> ${game.i18n.localize("OLATTACK.ToggleDetails")}</button>`;
  const buttonsHtml =
    cardKind === "damage"
      ? `${detailsBtn}<button type="button" class="ol-apply-damage" data-damages='${escapeHtml(JSON.stringify(appData))}'><i class="fa-solid fa-burst"></i> ${game.i18n.localize("OLATTACK.ApplyDamage")}</button>`
      : cardKind === "heal"
        ? `${detailsBtn}<button type="button" class="ol-apply-heal" data-heals='${escapeHtml(JSON.stringify(appData))}'><i class="fa-solid fa-heart-pulse"></i> ${game.i18n.localize("OLATTACK.ApplyHeal")}</button>`
        : detailsBtn;

  // content
  const content = `
  <div class="ol-chat" data-kind="${escapeHtml(cardKind)}">
    ${chatHead({ img: itemImg, title: rollTitle, tags })}
    <div class="ol-chat-body">
      ${opts.showDescription && opts.descriptionHtml ? `<div class="ol-chat-desc">${opts.descriptionHtml}</div>` : ""}
      ${specialNotes.length ? `<div class="ol-chat-note">${specialNotes.map((n) => escapeHtml(n)).join("<br>")}</div>` : ""}
      ${effectNote?.text ? `<div class="ol-chat-note is-info"><strong>${escapeHtml(effectNote.title || tt("OLATTACK.Chat.Reminder"))}</strong><br>${escapeHtml(effectNote.text).replace(/\n/g, "<br>")}</div>` : ""}
      <div class="ol-chat-result">${centerLabel}</div>
      ${breakdown}
      ${chatTargets(targets)}
      ${savesHtml}
    </div>
    <footer class="ol-chat-buttons">${buttonsHtml}</footer>
  </div>`;

  const msg = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor, token }),
    content,
    flags: flagsTarjeta({
          targets: targets.map((t) => t.document.uuid),
          targetsMeta,
          strictTargets: false,
          itemName: opts.itemName,
          systemMode: isHomebrew ? "homebrew" : "normal",
          attackTags,
          templateUuid: null,
          saveDefs,
          saveSuccessDamageMode,
          saveTrack: {},
          cardKind,
          damagePayload: cardKind === "damage" ? appData : [],
          healPayload: cardKind === "heal" ? appData : [],
          actionProfile: resolvedActionProfile?.profile || resolveActionProfile(item, actor)?.profile || null
        })
  });

  if (cardKind === "damage" && appData.length && targets.length) {
    const sourceTokenDoc = token?.document || token || null;
    await addPendingDamageLines({
      messageId: msg.id,
      itemName: opts.itemName || rollTitle || item?.name || "Daño",
      label: opts.itemName || rollTitle || item?.name || "Daño",
      source: {
        name: sourceTokenDoc?.name || actor?.name || "Origen",
        img: sourceTokenDoc?.texture?.src || actor?.img || "icons/svg/mystery-man.svg",
        actorUuid: actor?.uuid || null,
        tokenUuid: sourceTokenDoc?.uuid || null
      },
      targets: targets.map((t) => ({
        name: t?.name || t?.document?.name || t?.actor?.name || "Objetivo",
        img: t?.document?.texture?.src || t?.actor?.img || "icons/svg/mystery-man.svg",
        actorUuid: t?.actor?.uuid || null,
        tokenUuid: t?.document?.uuid || null
      })),
      parts: appData,
      damageType: appData[0]?.type || "damage",
      systemMode: isHomebrew ? "homebrew" : "normal",
      attackTags,
      saveSuccessDamageMode
    });
  }

  // Notificar a propietarios (jugadores) cuando haya TS pendientes.
  // (El chat card ya contiene el botón, pero esto sirve como "aviso" inmediato.)
  try {
    if (saveDefs?.length && Array.isArray(targetsMeta) && targetsMeta.length) {
      const userIds = new Set();
      const OWNER_LVL = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
      for (const t of targets) {
        const a = t?.actor;
        if (!a?.hasPlayerOwner) continue;
        for (const u of game.users ?? []) {
          if (u?.isGM) continue;
          if (typeof a.testUserPermission === "function" && a.testUserPermission(u, OWNER_LVL)) userIds.add(u.id);
        }
      }
      if (userIds.size) {
        game.socket?.emit?.(SOCKET_NS, {
          type: "saveRequest",
          messageId: msg.id,
          itemName: opts.itemName || opts.rollTitle || "Efecto",
          userIds: Array.from(userIds)
        });
      }
    }
  } catch {}

  return { message: msg, cardKind, total };
}
