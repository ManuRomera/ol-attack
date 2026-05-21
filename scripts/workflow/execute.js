import { FLAG_SCOPE, FLAG_KEY, SOCKET_NS } from "../shared/constants.js";
import { gp, safeNum, escapeHtml, cleanDiceBonus, translateDamageType, sanitizeFormulaLoose } from "../lib/utils.js";
import { getProfBonus, autoAbilityForItem, getActorDamageBonusFormula } from "../lib/actor.js";
import { getExhaustionInfo } from "../lib/exhaustion.js";
import { getDamagePartsDetailed, getHealingPartsDetailed, inferHpGrantParts } from "../lib/damage.js";
import { getItemUses, consumeItemUse } from "../lib/uses.js";
import { inferBonusDie, inferAutoEffectRoll } from "../lib/trait-infer.js";
import { getSavesFromItem, buildSaveDefs, renderSavesHtml } from "../lib/saves.js";
import { getItemTags } from "../lib/tags.js";
import { getAttackBypassTags } from "../lib/riv.js";
import { addPendingDamageLines } from "../lib/damage-ledger.js";
import { prepareRoll, makeAdjustedRoll } from "./rolls.js";
import { resolveActionProfile, getActionExecutionPlan, getWorkflowConfigFromProfile, validateActionConfigJson, mergeProfile } from "../lib/action-profiles.js";
import { setStatusOnSubject } from "../lib/statuses.js";
import { LegacyDialog } from "../shared/compat.js";
import { getActorHpData, getActorAbilityMod, getActorProfValue, getActorAcValue } from "../shared/system-data.js";



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
  const tHtml = targetDocs.map((t) => `<div style="font-size:11px;">🎯 ${escapeHtml(t.name)}</div>`).join("");
  const content = `
  <div class="dnd5e2 chat-card" style="padding:0;">
    <header class="card-header" style="display:flex; flex-direction:column; align-items:center; padding:0; border:0; background:transparent;">
      <img src="${escapeHtml(item?.img || "icons/svg/mystery-man.svg")}" onerror="this.src='icons/svg/mystery-man.svg'" title="${escapeHtml(item?.name || "Chispa divina")}" style="width:100%; height:auto; max-height:200px; object-fit:cover; border:0; border-radius:4px 4px 0 0;"/>
      <h3 class="item-name" style="margin:8px 0 4px 0; font-size:18px; border:0; width:100%; text-align:center;">${escapeHtml(item?.name || "Chispa divina")}</h3>
    </header>
    <div class="card-content" style="padding:0 8px 8px 8px;">
      <div style="text-align:center; font-size:18px; font-weight:800; color:#8B0000; margin:10px 0 6px 0;">Elige cómo resolver ${escapeHtml(item?.name || "la acción")}</div>
      <div style="font-size:12px; color:#444; margin-bottom:10px; text-align:center;">Puedes resolver esta acción en modo <b>Curar</b> o <b>Dañar</b>.</div>
      ${tHtml ? `<div style="margin-top:5px; padding:4px; background:rgba(0,0,0,0.05)">${tHtml}</div>` : ""}
    </div>
    <div class="card-buttons ol-choice-buttons" style="padding:0 8px 8px 8px;">
      <button type="button" class="ol-divine-spark-choice" data-choice="heal">Curar</button>
      <button type="button" class="ol-divine-spark-choice" data-choice="damage">Dañar</button>
    </div>
  </div>`;

  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor, token }),
    content,
    flags: {
      [FLAG_SCOPE]: {
        [FLAG_KEY]: {
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
        }
      }
    }
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

  return await new Promise((resolve) => {
    const content = `
      <div class="ol-theme-panel" style="display:flex; flex-direction:column; gap:10px;">
        <p style="margin:0;">Elige a qué objetivo aplicar <b>${escapeHtml(step?.label || actor?.name || "la acción")}</b>.</p>
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${availableTargets.map((t, index) => `
            <button type="button" class="ol-workflow-target-choice" data-index="${index}" style="text-align:left; padding:10px 12px; border-radius:10px; border:1px solid #5f5a4f; background:rgba(0,0,0,0.15); color:inherit;">${escapeHtml(t?.name || `Objetivo ${index + 1}`)}</button>
          `).join("")}
        </div>
      </div>`;
    const dlg = new LegacyDialog({
      title: `Elegir objetivo · ${step?.label || actor?.name || "OL Attack"}`,
      content,
      buttons: { cancel: { label: "Cancelar", callback: () => resolve([]) } },
      default: "cancel",
      close: () => resolve([])
    }, { width: 420 });
    dlg.render(true);
    setTimeout(() => {
      const html = dlg.element;
      if (!html?.length) return;
      html.addClass("ol-theme-dialog");
      html.find('.ol-workflow-target-choice').on('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const index = Number(ev.currentTarget.dataset.index || 0);
        const picked = availableTargets[index] ? [availableTargets[index]] : [];
        resolve(picked);
        dlg.close();
      });
    }, 0);
  });
}

async function _postWorkflowEffectCard({ actor, token, item, step, targetDocs = [] } = {}) {
  const title = escapeHtml(step?.label || item?.name || "Efecto");
  const text = String(step?.description || "").trim() || "Sin descripción.";
  const targetsHtml = targetDocs.map((t) => `<div style="font-size:11px;">🎯 ${escapeHtml(t.name)}</div>`).join("");
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor, token }),
    content: `
      <div class="dnd5e2 chat-card" style="padding:0;">
        <header class="card-header" style="display:flex; flex-direction:column; align-items:center; padding:0; border:0; background:transparent;">
          <img src="${escapeHtml(item?.img || 'icons/svg/mystery-man.svg')}" style="width:100%; height:auto; max-height:180px; object-fit:cover; border-radius:4px 4px 0 0;"/>
          <h3 class="item-name" style="margin:8px 0 4px 0; font-size:18px; border:0; width:100%; text-align:center;">${title}</h3>
        </header>
        <div class="card-content" style="padding:0 8px 10px 8px;">
          <div style="font-size:13px; line-height:1.45; color:#444;">${escapeHtml(text).replace(/\n/g,'<br>')}</div>
          ${targetsHtml ? `<div style="margin-top:8px; padding:4px; background:rgba(0,0,0,0.05)">${targetsHtml}</div>` : ''}
        </div>
      </div>`
  });
}

async function _chooseWorkflowBranch(step = {}) {
  const entries = Object.entries(step?.branches || {});
  if (!entries.length) return null;
  if (entries.length === 1) return entries[0][0];
  return await new Promise((resolve) => {
    const content = `
      <div class="ol-theme-panel" style="display:flex; flex-direction:column; gap:12px;">
        <p style="margin:0;">${escapeHtml(step?.description || `Elige cómo resolver ${step?.label || 'la acción'}.`)}</p>
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${entries.map(([key, branch]) => `
            <button type="button" class="ol-workflow-branch-choice" data-branch="${escapeHtml(key)}" style="text-align:left; padding:10px 12px; border-radius:10px; border:1px solid #5f5a4f; background:rgba(0,0,0,0.15); color:inherit;">
              <div style="font-weight:700;">${escapeHtml(branch?.label || key)}</div>
              ${branch?.description ? `<div style="font-size:11px; opacity:0.8; margin-top:3px;">${escapeHtml(branch.description)}</div>` : ''}
            </button>
          `).join("")}
        </div>
      </div>`;
    const dlg = new LegacyDialog({
      title: `Elegir modo · ${step?.label || 'Acción'}`,
      content,
      buttons: { cancel: { label: 'Cancelar', callback: () => resolve(null) } },
      default: 'cancel',
      close: () => resolve(null)
    }, { width: 440 });
    dlg.render(true);
    setTimeout(() => {
      const html = dlg.element;
      if (!html?.length) return;
      html.addClass('ol-theme-dialog');
      html.find('.ol-workflow-branch-choice').on('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const key = String(ev.currentTarget.dataset.branch || '').trim();
        resolve(key || null);
        dlg.close();
      });
    }, 0);
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
          content: `<div class="dnd5e2 chat-card" style="padding:8px 10px;"><h3 style="margin:0 0 6px 0; border:0;">${escapeHtml(label)}</h3><div style="font-size:13px; color:#444;">${escapeHtml(active ? 'Estado aplicado' : 'Estado quitado')}: <b>${escapeHtml(String(step?.statusId || ''))}</b>${applied.length ? ` → ${escapeHtml(applied.join(', '))}` : ''}</div></div>`
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

  const defense = (isHomebrew && !opts.disableDefense && targets.length === 1)
    ? (safeNum(getActorAcValue(targets[0]?.actor), NaN) - 10)
    : null;
  const applyDefense = Number.isFinite(defense) && defense > 0;

  const resolvedActionProfile = (!isOffhand && item)
    ? (opts?.resolvedActionProfile ? { profile: opts.resolvedActionProfile, source: "passed" } : resolveActionProfile(item, actor))
    : null;
  const profilePlan = (!isOffhand && item)
    ? getActionExecutionPlan({ actor, item, profile: resolvedActionProfile?.profile || null, targets, choiceMode: opts?.choiceMode || "", castLevel: safeNum(opts?.spellLevel, safeNum(item?.system?.level, 0)) })
    : null;

  const workflowConfig = (!isOffhand && item) ? getWorkflowConfigFromProfile(resolvedActionProfile?.profile || {}) : null;
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
    parts = opts.dmgMode === "manual"
      ? [{ formula: String(opts.manualFormula || "0"), type: String(opts.manualType || "bludgeoning") }]
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
      <div style="margin-top:6px; font-size:13px; border-bottom:1px solid #ccc; padding-bottom:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span><strong>Dado de bonificación</strong> <span style="font-size:11px; color:#555;">(${escapeHtml(lbl)})</span></span>
          <span style="font-weight:900; color:#8B0000;">${escapeHtml(die)}</span>
        </div>
        <div class="ol-hidden-details" style="display:none; color:#666; font-size:11px; margin-top:6px; background:rgba(0,0,0,0.03); padding:6px; border-radius:6px;">
          Este rasgo/hechizo concede un dado que el objetivo puede <b>sumar</b> a su tirada cuando corresponda.<br>
          Dado: <code>${escapeHtml(die)}</code>
        </div>
      </div>`;
  } else {

  for (let i = 0; i < rollParts.length; i++) {
    const part = rollParts[i] || {};
    const baseF = String(part.formula || "0");
    let f = baseF;
    let sumMod = 0, sumProf = 0, sumTemp = 0, sumExh = 0, sumDef = 0;
    let bonusApplied = "";

    if (cardKind === "damage" && i === 0 && !isOffhand) {
      if (isHomebrew) {
        const allowHomebrewAbilityMod = !(item?.type === "spell" && opts.ability === "auto");
        if (opts.dmgMode !== "manual" && allowHomebrewAbilityMod && mod) { f += ` + ${mod}`; sumMod = mod; }
        if (prof) { f += ` + ${prof}`; sumProf = prof; }
        if (temp) { f += ` + ${temp}`; sumTemp = temp; }
        if (opts.applyRage) f += ` + ${safeNum(opts.rageBonus, 0)}`;
        if (ex.level > 0 && exhaustionPenalty > 0) { f += ` - ${exhaustionPenalty}`; sumExh = -exhaustionPenalty; }

        // Bonos/penalizadores de estados (si son numéricos)
        if (actorDmgBonusSafe) { f += ` + (${actorDmgBonusSafe})`; bonusApplied = actorDmgBonusSafe; }
      } else {
        if (temp) { f += ` + ${temp}`; sumTemp = temp; }
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

      const rageVal = (isHomebrew && opts.applyRage) ? safeNum(opts.rageBonus, 0) : 0;
      const adds = [sumMod, sumProf, sumTemp, rageVal, sumExh, bonusVal];

      chosen = augmentRoll(baseChosen, adds);
      other = augmentRoll(baseOther, adds);
    } else {
      ({ chosen, other, allRolls } = await prepareRoll(f, mode, rollData));
    }

    if (game.dice3d && allRolls) dice3dPromises.push(...allRolls.map((r) => game.dice3d.showForRoll(r, game.user, true)));
    else if (game.dice3d) dice3dPromises.push(game.dice3d.showForRoll(chosen, game.user, true));

    let rollTotal = chosen.total;
    if (cardKind === "damage" && i === 0 && applyDefense) {
      chosen = makeAdjustedRoll(chosen, defense);
      if (other) other = makeAdjustedRoll(other, defense);
      rollTotal = chosen.total; sumDef = -defense;
    }

    total += rollTotal;
    appData.push({ amount: rollTotal, type: part.type || "bludgeoning", applyCurrent: !!part.applyCurrent, formula: chosen.formula || part.formula || "", label: part.label || "" });

    const diceResults = chosen.dice?.map((d) => `[${d.total}]`).join(" + ") || "";
    const labelTxt = part.label ? ` <span style="font-size:11px; color:#555;">(${escapeHtml(part.label)})</span>` : "";
    const totalAjustes = sumMod + sumProf + sumTemp + sumExh + sumDef;

    breakdown += `
      <div style="margin-top:4px; font-size:13px; border-bottom:1px solid #ccc; padding-bottom:4px;">
        <div style="display:flex; justify-content:space-between;">
          <span><strong>${rollTotal}</strong> ${escapeHtml(translateDamageType(part.type))}${labelTxt}</span>
        </div>
        <div class="ol-hidden-details" style="display:none; color:#666; font-size:11px; margin-top:2px; background:rgba(0,0,0,0.03); padding:4px; border-radius:4px;">
          ${part.label ? `Bonificación: <b>${escapeHtml(part.label)}</b><br>` : ""}
          Fórmula: <code>${escapeHtml(chosen.formula)}</code><br>
          Dados: <span style="color:#a00; font-weight:bold;">${escapeHtml(diceResults)}</span> = <b>${chosen.total}</b>
          ${other ? `<br>Tirada Doble: [${other.total}] vs [${chosen.total}]` : ""}
          ${applyDefense && i === 0 && cardKind === "damage" ? `<br>Defensa Homebrew (CA-10): -${defense} al daño` : ""}
          ${ex.level > 0 && isHomebrew && i === 0 && cardKind === "damage" ? `<br>😮‍💨 Cansancio ${ex.level} → -${exhaustionPenalty} (solo daño)` : ""}
          ${bonusApplied ? `<br>🧩 Bonos/Estados (actor): <code>${escapeHtml(bonusApplied)}</code>` : ""}
          ${part.isScaled ? `<br>🔮 Aumentado por Upcast` : ""}
          <div style="margin-top:6px; padding-top:6px; border-top:1px dashed rgba(0,0,0,0.15);">
            <div><b>Base:</b> <code>${escapeHtml(String(part.formula || "0"))}</code></div>
            <div><b>Mod:</b> ${sumMod >= 0 ? "+" : ""}${sumMod}</div>
            <div><b>Prof:</b> ${sumProf >= 0 ? "+" : ""}${sumProf}</div>
            <div><b>Temp:</b> ${sumTemp >= 0 ? "+" : ""}${sumTemp}</div>
            <div><b>Cansancio:</b> ${sumExh >= 0 ? "+" : ""}${sumExh}</div>
            ${bonusApplied ? `<div><b>Bonos/Estados:</b> <code>${escapeHtml(bonusApplied)}</code></div>` : ""}
            <div><b>Defensa:</b> ${sumDef >= 0 ? "+" : ""}${sumDef}</div>
            <div style="margin-top:3px;"><b>Total ajustes:</b> ${totalAjustes >= 0 ? "+" : ""}${totalAjustes}</div>
          </div>
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
        <div style="margin-top:8px; font-size:13px; border:1px dashed rgba(0,0,0,0.25); padding:6px; border-radius:8px; background:rgba(0,0,0,0.03);">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span><strong>🎲 ${escapeHtml(traitExtraRoll.label || "Dados extra")}</strong></span>
            <span style="font-weight:900; color:#8B0000;">${escapeHtml(String(r.total))}</span>
          </div>
          <div class="ol-hidden-details" style="display:none; color:#666; font-size:11px; margin-top:6px;">
            Fórmula: <code>${escapeHtml(String(r.formula))}</code><br>
            Dados: <span style="color:#a00; font-weight:bold;">${escapeHtml(diceResults)}</span> = <b>${escapeHtml(String(r.total))}</b>
          </div>
        </div>`;
    } catch (e) {
      breakdown += `
        <div style="margin-top:8px; font-size:12px; border:1px dashed rgba(0,0,0,0.25); padding:6px; border-radius:8px; background:rgba(255,0,0,0.04); color:#8B0000;">
          🎲 Dados extra: no se pudo tirar (<code>${escapeHtml(String(e?.message || e))}</code>)
        </div>`;
    }
  }

  if (dice3dPromises.length) Promise.allSettled(dice3dPromises);

  // Saves
  const suppressSavesForItem = item && isTollTheDeadItem(item, actor) && profilePlan?.showSaves !== true;
  const saves = (opts.showSaves && item && !suppressSavesForItem) ? await getSavesFromItem(item, actor, { isHomebrew }) : [];
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
    ? `${total} DAÑO`
    : cardKind === "heal"
      ? (isTempMax ? `+${total} PG MÁX` : (isTempHp ? `+${total} PG TEMP` : `+${total} CURACIÓN`))
      : cardKind === "bonusdie"
        ? `DADO: ${String(bonusDieInfo?.formula || "").trim()}`
        : cardKind === "effectRoll"
          ? `${total} ${(/reducci/i.test(String(rollParts[0]?.label||""))) ? "REDUCCIÓN" : "EFECTO"}`
          : `EFECTO`;

  const buttonsHtml =
    cardKind === "damage"
      ? `<button type="button" class="ol-toggle-details">${game.i18n.localize("OLATTACK.ToggleDetails")}</button><button type="button" class="ol-apply-damage" data-damages='${escapeHtml(JSON.stringify(appData))}'>${game.i18n.localize("OLATTACK.ApplyDamage")}</button>`
      : cardKind === "heal"
        ? `<button type="button" class="ol-toggle-details">${game.i18n.localize("OLATTACK.ToggleDetails")}</button><button type="button" class="ol-apply-heal" data-heals='${escapeHtml(JSON.stringify(appData))}'>${game.i18n.localize("OLATTACK.ApplyHeal")}</button>`
        : `<button type="button" class="ol-toggle-details">${game.i18n.localize("OLATTACK.ToggleDetails")}</button>`;

  const tHtml = targets.map((t) => `<div style="font-size:11px;">🎯 ${escapeHtml(t.name)}</div>`).join("");

  // content
  const content = `
  <div class="dnd5e2 chat-card" style="padding:0;">
    <header class="card-header" style="display:flex; flex-direction:column; align-items:center; padding:0; border:0; background:transparent;">
      <img src="${itemImg}" onerror="this.src='icons/svg/sword.svg'" title="${escapeHtml(rollTitle)}" style="width:100%; height:auto; max-height:200px; object-fit:cover; border:0; border-radius:4px 4px 0 0;"/>
      <h3 class="item-name" style="margin:8px 0 4px 0; font-size:18px; border:0; width:100%; text-align:center;">${escapeHtml(rollTitle)}</h3>
      <div style="display:flex; flex-wrap:wrap; justify-content:center; gap:4px; margin-bottom:8px; padding:0 8px;">
        ${tags.map((tag) => `<span style="font-size:9px; font-weight:bold; color:#444; border:1px solid #999; border-radius:3px; padding:1px 4px; text-transform:uppercase; background:rgba(255,255,255,0.5);">${escapeHtml(tag)}</span>`).join("")}
      </div>
    </header>
    <div class="card-content" style="padding:0 8px 8px 8px;">
      ${opts.showDescription && opts.descriptionHtml ? `<div style="font-size:12px; color:#444; margin-bottom:10px; border-bottom:1px solid #ccc; padding-bottom:8px; max-height:150px; overflow-y:auto;">${opts.descriptionHtml}</div>` : ""}
      ${specialNotes.length ? `<div style="margin:0 0 10px 0; padding:8px 10px; border:1px dashed #b58900; border-radius:8px; background:rgba(181,137,0,0.08); font-size:11px; color:#6b5600;">${specialNotes.map((n) => escapeHtml(n)).join("<br>")}</div>` : ""}
      ${effectNote?.text ? `<div style="margin:0 0 10px 0; padding:8px 10px; border:1px solid rgba(210,154,56,0.45); border-radius:8px; background:rgba(210,154,56,0.08); font-size:12px; color:#5a430a;"><div style="font-weight:800; margin-bottom:4px;">${escapeHtml(effectNote.title || "Recordatorio")}</div><div>${escapeHtml(effectNote.text).replace(/\n/g, "<br>")}</div></div>` : ""}
      <div style="text-align:center; font-size:24px; font-weight:bold; color:#8B0000; margin:10px 0;">${centerLabel}</div>
      ${breakdown}
      ${tHtml ? `<div style="margin-top:5px; padding:4px; background:rgba(0,0,0,0.05)">${tHtml}</div>` : ""}
      ${savesHtml}
    </div>
    <div class="card-buttons" style="padding:0 8px 8px 8px;">${buttonsHtml}</div>
  </div>`;

  const msg = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor, token }),
    content,
    flags: {
      [FLAG_SCOPE]: {
        [FLAG_KEY]: {
          targets: targets.map((t) => t.document.uuid),
          targetsMeta,
          strictTargets: false,
          itemName: opts.itemName,
          systemMode: isHomebrew ? "homebrew" : "normal",
          attackTags,
          templateUuid: null,
          saveDefs,
          saveTrack: {},
          cardKind,
          damagePayload: cardKind === "damage" ? appData : [],
          healPayload: cardKind === "heal" ? appData : [],
          actionProfile: resolvedActionProfile?.profile || resolveActionProfile(item, actor)?.profile || null
        }
      }
    }
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
      attackTags
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
