import { gp, safeNum, sanitizeFormula, sanitizeFormulaLoose } from "./utils.js";
import { getActorHpData, updateActorHpData, getActorTraits, getActorClasses, getActorLevel, getActorChallenge, getActorAcValue } from "../shared/system-data.js";
import { getActivities, normalizeDamageType } from "./actor.js";
import { toSet, firstIntersection, bypassLabel, getTraitBypasses, traitHasType, BYPASS_CANON } from "./riv.js";

const stripRedundantAbilityBonus = (formula, abilityMod) => {
  const f = sanitizeFormula(formula);
  const m = f.match(/^(.*?)([+-])\s*(\d+)\s*$/);
  const core = m?.[1]?.trim?.() ?? "";
  const sign = m?.[2];
  const num = m?.[3] ? Number(m[3]) : null;
  const tailVal = num == null ? null : sign === "-" ? -num : num;
  return m && /\b\d*d\d+\b/i.test(core) && tailVal === abilityMod ? core : f;
};

// ============================================================
// Upcast (D&D5e v13+ Activities)
// ============================================================
// En dnd5e 5.2+ el scaling se define en cada parte de daño/curación:
//   part.scaling.mode = "whole" | "half"
//   part.scaling.number = dados extra por paso
//   part.scaling.formula = fórmula extra escalable
// y el sistema expone DamageData.scaledFormula(increase).
// Para compendios/imports con objetos planos, replicamos la lógica.

const _autoFormula = (p, dieIncrease = 0) => {
  let formula;
  const number = safeNum(gp(p, "number"), 0) + safeNum(dieIncrease, 0);
  const denomination = safeNum(gp(p, "denomination"), 0);
  if (number && denomination) formula = `${number}d${denomination}`;
  const bonus = String(gp(p, "bonus") ?? "").trim();
  if (bonus && bonus !== "0") formula = formula ? `${formula} + (${bonus})` : bonus;
  return formula ?? "";
};

const _basePartFormula = (p) => {
  const f = gp(p, "formula");
  if (typeof f === "string" && f.trim()) return f;
  if (gp(p, "custom.enabled") && gp(p, "custom.formula")) return String(gp(p, "custom.formula"));
  if (gp(p, "number") && gp(p, "denomination")) return _autoFormula(p, 0);
  return "";
};

const _scaledPartFormula = (p, increaseSteps) => {
  const base = _basePartFormula(p);
  const inc = safeNum(increaseSteps, 0);
  if (!inc || !p) return { formula: base, isScaled: false };

  const mode = String(gp(p, "scaling.mode") || "").toLowerCase();
  let incEff = inc;
  switch (mode) {
    case "whole": break;
    case "half": incEff = Math.floor(incEff * 0.5); break;
    default: incEff = 0; break;
  }
  if (!incEff) return { formula: base, isScaled: false };

  try {
    // El método nativo ya aplica su propia lógica de mode (whole/half)
    if (typeof p.scaledFormula === "function") {
      const sf = p.scaledFormula(inc);
      return { formula: String(sf ?? base), isScaled: String(sf ?? "") !== String(base ?? "") };
    }
  } catch {}

  let formula;
  const diePerStep = safeNum(gp(p, "scaling.number"), 1);
  const dieIncrease = diePerStep * incEff;

  if (gp(p, "custom.enabled")) {
    formula = String(gp(p, "custom.formula") || "");
    formula = formula.replace(/^(\d+)d/i, (match, num) => `${Number(num) + dieIncrease}d`);
  } else {
    formula = _autoFormula(p, dieIncrease);
  }

  const scF = String(gp(p, "scaling.formula") || "").trim();
  if (scF) {
    try {
      let roll = new Roll(scF);
      roll = roll.alter(incEff, 0, { multiplyNumeric: true });
      formula = formula ? `${formula} + ${roll.formula}` : roll.formula;
    } catch {
      formula = formula ? `${formula} + (${scF}) * ${incEff}` : `(${scF}) * ${incEff}`;
    }
  }

  return { formula, isScaled: String(formula ?? "") !== String(base ?? "") };
};

// Base level robusto (algunos compendios/imports guardan level como string u objeto)
const getSpellBaseLevel = (item) => {
  const raw = gp(item, "system.level");
  if (Number.isFinite(Number(raw))) return safeNum(raw, 0);
  if (raw && typeof raw === "object") return safeNum(raw.value ?? raw.level ?? raw.base ?? 0, 0);
  return 0;
};

// ============================================================
// Fallbacks de upcast (cuando el scaling NO está configurado en parts)
// ============================================================
// En muchos conjuros (o imports) el aumento por nivel está en:
//   item.system.scaling = { mode: "level"|"cantrip"|"none", formula: "1d8" }
// y/o solo está descrito en el texto ("A niveles superiores...").

const _stripHtml = (html) => String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const _getSystemScaling = (item) => {
  const sc = gp(item, "system.scaling");
  if (!sc || typeof sc !== "object") return null;
  const mode = String(gp(sc, "mode") || "").toLowerCase();
  const formula = String(gp(sc, "formula") || "").trim();
  if (!formula || formula === "0" || mode === "none") return null;
  // Solo nos interesa el upcast por nivel de slot; ignoramos cantrip aquí.
  if (!(mode === "level" || mode === "spell" || mode === "slot" || mode.includes("level"))) return null;
  return { formula, per: 1 };
};

const _inferScalingFromDescription = (item) => {
  const raw = gp(item, "system.description.value") ?? gp(item, "system.description.chat") ?? "";
  const txt = _stripHtml(raw);
  if (!txt) return null;

  // Detectar "cada X niveles" / "every X levels"
  let per = 1;
  const mPer = txt.match(/(?:cada|every)\s+(\d+)\s+(?:niveles?|levels?)/i);
  if (mPer) per = Math.max(1, parseInt(mPer[1]));

  // Extra dice típico
  const mDice = txt.match(/(?:aumenta(?:n)?\s+en|increases?\s+by)\s*(\d+d\d+)/i)
    || txt.match(/(?:por\s+cada\s+nivel\s+de\s+espacio|for\s+each\s+slot\s+level)[^\d]*(\d+d\d+)/i);
  if (mDice) return { formula: mDice[1], per };

  return null;
};

const _getUpcastScaling = (item) => _getSystemScaling(item) || _inferScalingFromDescription(item);

const _getCantripScaling = (item) => {
  const sc = gp(item, "system.scaling");
  if (!sc || typeof sc !== "object") return null;
  const mode = String(gp(sc, "mode") || "").toLowerCase();
  const formula = String(gp(sc, "formula") || "").trim();
  if (!formula || formula === "0") return null;
  if (!(mode === "cantrip" || mode.includes("cantrip"))) return null;
  return { formula, per: 1 };
};

const _getActorTotalLevelForCantrip = (actor) => {
  if (!actor) return 0;
  let lvl = safeNum(getActorLevel(actor), NaN);
  if (!Number.isFinite(lvl) || lvl <= 0) {
    const classes = getActorClasses(actor);
    if (classes && typeof classes === "object") {
      lvl = Object.values(classes).reduce((sum, cls) => sum + safeNum(gp(cls, "levels") ?? gp(cls, "system.levels") ?? gp(cls, "level"), 0), 0);
    }
  }
  if (!Number.isFinite(lvl) || lvl <= 0) lvl = safeNum(getActorChallenge(actor), 0);
  return Math.max(0, lvl);
};

const _getCantripScaleSteps = (actor) => {
  const lvl = _getActorTotalLevelForCantrip(actor);
  if (lvl >= 17) return 3;
  if (lvl >= 11) return 2;
  if (lvl >= 5) return 1;
  return 0;
};

const _applyScalingAddition = (base, scaleFormula, steps, per = 1) => {
  const inc = safeNum(steps, 0);
  const step = Math.floor(inc / Math.max(1, safeNum(per, 1)));
  if (!step || !scaleFormula) return { formula: base, isScaled: false };

  try {
    let r = new Roll(String(scaleFormula));
    r = r.alter(step, 0, { multiplyNumeric: true });
    const extra = String(r.formula || "").trim();
    if (!extra) return { formula: base, isScaled: false };
    const f = base ? `(${base}) + ${extra}` : extra;
    return { formula: f, isScaled: true };
  } catch {
    const extra = `(${scaleFormula}) * ${step}`;
    const f = base ? `(${base}) + ${extra}` : extra;
    return { formula: f, isScaled: true };
  }
};

// ============================================================
// HP boons (Temp HP / Temp Max HP) desde "hechizos de efecto" (sin daño/curación)
// ============================================================
// Algunos conjuros/rasgos (p.ej. Aid, False Life, dotes, auras) no exponen curación en activities,
// pero sí describen o aplican PG temporales / máximo temporal. Esta función intenta inferirlo
// para que la macro pueda generar tarjeta con botón "Aplicar".

const _firstEffectHpChange = (item) => {
  try {
    const effects = item?.effects?.contents ?? item?.effects ?? [];
    for (const ef of effects) {
      const ch = ef?.changes ?? ef?.system?.changes ?? [];
      for (const c of ch) {
        const key = String(c?.key || "");
        const val = String(c?.value ?? "").trim();
        if (!key || !val) continue;
        if (key.includes("system.attributes.hp.tempmax") || key.includes("attributes.hp.tempmax")) {
          return { type: "tempmax", formula: val, applyCurrent: true, source: "effect" };
        }
        if (key.includes("system.attributes.hp.temp") || key.includes("attributes.hp.temp")) {
          return { type: "temphp", formula: val, applyCurrent: false, source: "effect" };
        }
      }
    }
  } catch {}
  return null;
};

const _inferHpFromDescription = (item, { castLevel = 0, baseLevel = 0 } = {}) => {
  const raw = gp(item, "system.description.value") ?? gp(item, "system.description.chat") ?? "";
  const txt = _stripHtml(raw);
  if (!txt) return null;

  const lower = txt.toLowerCase();
  // Especial: Aid/Ayuda — en esta mesa se gestiona como "PG Temporales" (acumulables).
  // Importante: muchos compendios/idiomas cambian el nombre (p.ej. "Aid (2024)", "Ayuda (SRD)").
  // Para ser robustos, lo detectamos por identifier (si existe) y por prefijo del nombre.
  const nm = String(item?.name ?? "").toLowerCase().trim();
  const ident = String(gp(item, "system.identifier") || "").toLowerCase().trim();
  const isAidById = ident === "aid";
  const isAidByName = /^(aid|ayuda)\b/i.test(nm);
  if (isAidById || isAidByName) {
    const partsA = txt.split(/at higher levels\.?|a niveles superiores\.?/i);
    const baseTxtA = partsA[0] || txt;
    const higherTxtA = partsA[1] || "";

    const baseMatch = baseTxtA.match(/(?:increase(?:s)?\s+by|aumenta(?:n)?\s+en|hit points\s+increase\s+by|puntos\s+de\s+golpe\s+aumenta(?:n)?\s+en)\s*(\d+)/i);
    const baseNumA = baseMatch ? safeNum(baseMatch[1], 5) : 5;

    const htA = higherTxtA || txt;
    const thMatch = htA.match(/slot level above\s*(\d+)/i) || htA.match(/por\s+encima\s+de\s*(\d+)/i) || htA.match(/superior(?:es)?\s+a\s*(\d+)/i);
    const thresholdA = thMatch ? safeNum(thMatch[1], (baseLevel || 2)) : (baseLevel || 2);

    const incMatch = htA.match(/additional\s*(\d+)/i) || htA.match(/increase(?:s)?\s+by\s*(\d+)/i) || htA.match(/aumenta(?:n)?\s+en\s*(\d+)/i);
    const incA = incMatch ? safeNum(incMatch[1], 5) : 5;

    let formulaA = String(baseNumA);
    let isScaledA = false;
    if (Number.isFinite(castLevel) && Number.isFinite(thresholdA) && castLevel > thresholdA) {
      const steps = castLevel - thresholdA;
      isScaledA = steps > 0;
      formulaA = String(baseNumA + incA * steps);
    }
    // Siempre como PG temporales acumulables (NO curación, NO max HP) para imitar el comportamiento tipo Heroísmo.
    return { type: "temphpAdd", formula: formulaA, applyCurrent: false, isScaled: isScaledA, source: "description" };
  }


  const isTempHp = lower.includes("temporary hit points") || lower.includes("puntos de golpe temporales") || lower.includes("pg temporales");
  const isMaxHp = lower.includes("hit point maximum") || lower.includes("maximum hit points") || lower.includes("puntos de golpe máximos") || lower.includes("puntos de golpe maximos");
  if (!isTempHp && !isMaxHp) return null;

  const parts = txt.split(/at higher levels\.?|a niveles superiores\.?/i);
  const baseTxt = parts[0] || txt;
  const higherTxt = parts[1] || "";

  // ¿también aumenta PG actuales?
  const applyCurrent = isMaxHp && (lower.includes("current hit points") || lower.includes("puntos de golpe actuales") || lower.includes("current hp"));

  // Base formula (preferimos dados si existen)
  const diceRe = /(\d+d\d+(?:\s*[+\-]\s*\d+)*)/i;
  const numRe = /\b(\d+)\b/;
  let baseFormula = "";
  let baseNum = null;

  if (isTempHp) {
    // buscar fórmula cerca de la mención
    const m = baseTxt.match(diceRe);
    if (m) baseFormula = m[1];
    const n = baseTxt.match(numRe);
    if (!baseFormula && n) baseNum = safeNum(n[1], null);
  } else {
    // max hp: normalmente es un número
    const n = baseTxt.match(/(?:increase(?:s)?\s+by|aumenta(?:n)?\s+en)\s*(\d+)/i) || baseTxt.match(numRe);
    if (n) baseNum = safeNum(n[1], null);
  }
  if (!baseFormula && baseNum == null) return null;

  // Escalado por nivel de slot (Aid, False Life, etc.)
  let inc = null;
  let threshold = null;

  const ht = higherTxt || txt;
  // threshold: "above 2nd" / "por encima de 2"
  const mTh = ht.match(/slot level above\s*(\d+)/i)
    || ht.match(/por\s+encima\s+de\s*(\d+)/i)
    || ht.match(/superior(?:es)?\s+a\s*(\d+)/i);
  if (mTh) threshold = safeNum(mTh[1], null);
  if (threshold == null) threshold = baseLevel || 0;

  // increment: "increases by 5" / "aumenta en 5"
  const mInc = ht.match(/increase(?:s)?\s+by\s*(\d+)/i)
    || ht.match(/aumenta(?:n)?\s+en\s*(\d+)/i);
  if (mInc) inc = safeNum(mInc[1], null);

  let formula = baseFormula || (baseNum != null ? String(baseNum) : "");
  let isScaled = false;
  if (Number.isFinite(castLevel) && Number.isFinite(threshold) && inc != null && castLevel > threshold) {
    const steps = castLevel - threshold;
    isScaled = steps > 0;
    if (baseFormula) {
      formula = `(${baseFormula}) + (${inc}) * ${steps}`;
    } else if (baseNum != null) {
      formula = String(baseNum + inc * steps);
    }
  }

  return {
    type: (() => {
      const nm = String(item?.name ?? "").toLowerCase().trim();
      const ident = String(gp(item, "system.identifier") || "").toLowerCase().trim();
      // En esta mesa, Aid se gestiona como PG Temporales (acumulables).
      // No dependemos del texto porque suele hablar de "maximum".
      const treatAidAsTemp = isMaxHp && (ident === "aid" || /^(aid|ayuda)\b/i.test(nm));
      if (isTempHp) return "temphp";
      if (treatAidAsTemp) return "temphpAdd";
      return "tempmax";
    })(),
    formula,
    applyCurrent: (() => {
      // Solo aplica a PG actuales cuando es tempmax. Para temphp no tocamos hp.value.
      const nm = String(item?.name ?? "").toLowerCase().trim();
      const ident = String(gp(item, "system.identifier") || "").toLowerCase().trim();
      const treatAidAsTemp = isMaxHp && (ident === "aid" || /^(aid|ayuda)\b/i.test(nm));
      if (isTempHp || treatAidAsTemp) return false;
      return applyCurrent;
    })(),
    isScaled,
    source: "description"
  };
};

export function inferHpGrantParts(item, { castLevel = 0 } = {}) {
  if (!item) return null;
  const baseLevel = getSpellBaseLevel(item);

  // 1) Preferimos texto (permite escalado por upcast), luego AE si existe
  const fromDesc = _inferHpFromDescription(item, { castLevel, baseLevel });
  const fromEf = _firstEffectHpChange(item);
  const picked = fromDesc || fromEf;
  if (!picked || !picked.formula) return null;

  return {
    parts: [{
      formula: sanitizeFormulaLoose(picked.formula),
      type: picked.type,
      label: (picked.type === "temphp" || picked.type === "temphpAdd") ? "PG Temporales" : "PG Máx (temporal)",
      isScaled: !!picked.isScaled,
      applyCurrent: !!picked.applyCurrent
    }],
    meta: { source: picked.source }
  };
}

export function getDamagePartsDetailed(item, { stripRedundant = false, abilityMod = 0, upcastLevel = 0, actor = null } = {}) {
  const out = [];
  let actArray = getActivities(item);
  const baseLevel = getSpellBaseLevel(item);
  const upcastSteps = (item?.type === "spell" && upcastLevel > baseLevel) ? (upcastLevel - baseLevel) : 0;
  const upcastScaling = upcastSteps ? _getUpcastScaling(item) : null;
  const cantripSteps = (item?.type === "spell" && baseLevel === 0) ? _getCantripScaleSteps(actor) : 0;
  const cantripScaling = cantripSteps ? _getCantripScaling(item) : null;

  // Fallback: ítems antiguos sin activities
  if ((!actArray || !actArray.length) && Array.isArray(gp(item, "system.damage.parts"))) {
    actArray = [{ type: "legacy", damage: { parts: gp(item, "system.damage.parts") } }];
  }

  for (const a of actArray) {
    if (!Array.isArray(gp(a, "damage.parts"))) continue;
    const parts = gp(a, "damage.parts");
    parts.forEach((p, idx) => {
      let formula = "";
      let dtype = "bludgeoning";

      if (typeof p === "object" && !Array.isArray(p)) {
        dtype = normalizeDamageType(gp(p, "types"), gp(p, "type") || "bludgeoning");
        if (gp(p, "custom.enabled") && gp(p, "custom.formula")) formula = gp(p, "custom.formula");
        else if (gp(p, "number") && gp(p, "denomination")) {
          formula = `${gp(p, "number")}d${gp(p, "denomination")}`;
          let bonus = String(gp(p, "bonus") ?? "").trim();
          if (bonus && bonus !== "0") formula += ` + (${bonus})`;
        }
      } else if (Array.isArray(p)) {
        if (p[0]) formula = p[0];
        if (p[1]) dtype = p[1];
      }
      if (!formula) return;

      let clean = sanitizeFormulaLoose(formula);
      let isScaled = false;

      if (upcastSteps && typeof p === "object" && !Array.isArray(p)) {
        const scaled = _scaledPartFormula(p, upcastSteps);
        if (scaled?.formula) {
          clean = sanitizeFormulaLoose(scaled.formula);
          isScaled = !!scaled.isScaled;
        }
      }

      // Fallback: scaling del ítem (system.scaling o texto) si la part no escala por sí misma.
      if (upcastSteps && !isScaled && upcastScaling && idx === 0) {
        const scaled2 = _applyScalingAddition(clean, upcastScaling.formula, upcastSteps, upcastScaling.per);
        clean = sanitizeFormulaLoose(scaled2.formula);
        isScaled = !!scaled2.isScaled;
      }

      // Escalado de trucos (niveles 5/11/17).
      if (cantripSteps && !isScaled && cantripScaling && idx === 0) {
        const scaled3 = _applyScalingAddition(clean, cantripScaling.formula, cantripSteps, cantripScaling.per);
        clean = sanitizeFormulaLoose(scaled3.formula);
        isScaled = !!scaled3.isScaled;
      }

      out.push({ formula: stripRedundant ? stripRedundantAbilityBonus(clean, abilityMod) : clean, type: dtype, isScaled });
    });
  }
  return out;
}

export function getHealingPartsDetailed(item, { upcastLevel = 0 } = {}) {
  const out = [];
  let actArray = getActivities(item);
  const baseLevel = getSpellBaseLevel(item);
  const upcastSteps = (item?.type === "spell" && upcastLevel > baseLevel) ? (upcastLevel - baseLevel) : 0;
  const upcastScaling = upcastSteps ? _getUpcastScaling(item) : null;

  // Aid/Ayuda: en esta mesa se gestiona SIEMPRE como "PG temporales que se suman" (no cura PG normales).
  // IMPORTANTÍSIMO: algunos compendios lo modelan como curación o como aumento de máximo, así que lo forzamos aquí.
  const _descHealRaw = gp(item, "system.description.value") ?? gp(item, "system.description.chat") ?? "";
  const _descHeal = _stripHtml(_descHealRaw).toLowerCase();
  const _nmHeal = String(item?.name ?? "").toLowerCase().trim();
  const _identHeal = String(gp(item, "system.identifier") || "").toLowerCase().trim();
  const isAidLike = (() => {
    if (!item) return false;
    if (_identHeal === "aid" || _identHeal.includes("aid")) return true;
    if (/\baid\b/.test(_nmHeal) || /^ayuda\b/.test(_nmHeal) || /\bayuda\b/.test(_nmHeal)) return true;
    // Fallback por texto + nivel (para nombres raros/compendios traducidos)
    const lvl = baseLevel;
    const hasMax = _descHeal.includes("hit point maximum") || _descHeal.includes("maximum hit points") || _descHeal.includes("puntos de golpe máxim") || _descHeal.includes("puntos de golpe maxim");
    const hasInc = _descHeal.includes("increase") || _descHeal.includes("increases") || _descHeal.includes("aument");
    const has5 = /\b5\b/.test(_descHeal) || _descHeal.includes("cinco");
    return item.type === "spell" && lvl === 2 && hasMax && hasInc && has5;
  })();

  // Fallback: algunos conjuros antiguos representan curación como damage.parts con type=healing
  if ((!actArray || !actArray.length) && Array.isArray(gp(item, "system.damage.parts"))) {
    const parts = gp(item, "system.damage.parts");
    const hasHeal = parts.some((p) => {
      if (!Array.isArray(p)) return false;
      const t = String(p[1] || "").toLowerCase();
      return t.includes("heal") || t.includes("temphp") || t.includes("temp");
    });
    if (hasHeal) actArray = [{ type: "legacy", healing: { parts: parts.map((p) => ({ formula: p[0], type: p[1] })) } }];
  }

  for (const a of actArray) {
    let parts = gp(a, "healing.parts") ?? gp(a, "heal.parts") ?? null;

    if (!Array.isArray(parts) || !parts.length) {
      const hp = gp(a, "healing") ?? gp(a, "heal");
      if (hp && !Array.isArray(hp) && (hp.number || hp.formula || hp.custom?.formula || hp.denomination)) parts = [hp];
      else if (Array.isArray(hp)) parts = hp;
    }
    if (!Array.isArray(parts) || !parts.length) continue;

    parts.forEach((p, idx) => {
      let formula = "";
      if (typeof p === "object" && !Array.isArray(p)) {
        if (gp(p, "custom.enabled") && gp(p, "custom.formula")) formula = gp(p, "custom.formula");
        else if (gp(p, "number") && gp(p, "denomination")) {
          formula = `${gp(p, "number")}d${gp(p, "denomination")}`;
          let bonus = String(gp(p, "bonus") ?? "").trim();
          if (bonus && bonus !== "0") formula += ` + (${bonus})`;
        } else if (gp(p, "formula")) formula = gp(p, "formula");
      } else if (Array.isArray(p)) {
        if (p[0]) formula = p[0];
      }
      if (!formula) return;

      let clean = sanitizeFormulaLoose(formula);
      let isScaled = false;

      if (upcastSteps && typeof p === "object" && !Array.isArray(p)) {
        const scaled = _scaledPartFormula(p, upcastSteps);
        if (scaled?.formula) {
          clean = sanitizeFormulaLoose(scaled.formula);
          isScaled = !!scaled.isScaled;
        }
      }

      // Fallback: scaling del ítem (system.scaling o texto) si la part no escala por sí misma.
      if (upcastSteps && !isScaled && upcastScaling && idx === 0) {
        const scaled2 = _applyScalingAddition(clean, upcastScaling.formula, upcastSteps, upcastScaling.per);
        clean = sanitizeFormulaLoose(scaled2.formula);
        isScaled = !!scaled2.isScaled;
      }

      let hType = "healing";
      const aHealTypeRaw = gp(a, "healing.type") ?? gp(a, "heal.type");
      const pTypeRaw = gp(p, "type") || (Array.isArray(gp(p, "types")) ? gp(p, "types")[0] : null) || (gp(p, "types") instanceof Set ? Array.from(gp(p, "types"))[0] : null);
      const aHealType = String(aHealTypeRaw || "").toLowerCase();
      const pType = String(pTypeRaw || "").toLowerCase();
      // dnd5e usa "temphp" pero algunos imports/homebrew usan "temp" / "temporary".
      if (aHealType.includes("temp") || pType.includes("temp")) hType = "temphp";

      // FORZAR Aid/Ayuda -> PG temporales acumulables (NO curación a hp.value)
      if (isAidLike) hType = "temphpAdd";

      out.push({ formula: clean, type: hType, isScaled });
    });
  }
  return out;
}

export function getDamageModifiers(targetActor, damageType, { homebrew = false, attackTags = [] } = {}) {
  const atkRaw = toSet(attackTags);
  const atk = new Set();
  for (const t of atkRaw) {
    const c = BYPASS_CANON(t);
    if (c) atk.add(c);
  }

  const traits = getActorTraits(targetActor);
  const diSet = toSet(gp(traits, "di.value") || []);
  const drSet = toSet(gp(traits, "dr.value") || []);
  const dvSet = toSet(gp(traits, "dv.value") || []);

  const diBy = getTraitBypasses(targetActor, "di");
  const drBy = getTraitBypasses(targetActor, "dr");
  const dvBy = getTraitBypasses(targetActor, "dv");

  if (traitHasType(diSet, damageType)) {
    const hit = firstIntersection(atk, diBy);
    if (hit) return { multiplier: 1, label: `Ignora inmunidad (${bypassLabel(hit)})` };
    return { multiplier: 0, label: "Inmune" };
  }

  if (traitHasType(drSet, damageType)) {
    const hit = firstIntersection(atk, drBy);
    if (hit) return { multiplier: 1, label: `Ignora resistencia (${bypassLabel(hit)})` };
    return { multiplier: 0.67, label: "Resistente (-33%)" };
  }

  if (traitHasType(dvSet, damageType)) {
    const hit = firstIntersection(atk, dvBy);
    if (hit) return { multiplier: 1, label: `Ignora vulnerabilidad (${bypassLabel(hit)})` };
    return { multiplier: 1.33, label: "Vulnerable (+33%)" };
  }

  return { multiplier: 1, label: null };
}

export function getDamagePreview(targetActor, amount, damageType = "bludgeoning", { homebrew = false, attackTags = [], disableDefense = false } = {}) {
  amount = Math.max(0, safeNum(amount, 0));
  if (!amount) return { applied: 0, modified: false, original: 0, defended: 0, defense: 0, multiplier: 1, type: damageType, modifier: null };

  const defense = (homebrew && !disableDefense)
    ? Math.max(0, safeNum(getActorAcValue(targetActor), 10) - 10)
    : 0;
  const defended = Math.max(0, Math.floor(amount - defense));
  const { multiplier, label } = getDamageModifiers(targetActor, damageType, { homebrew, attackTags });
  const applied = Math.floor(defended * multiplier);
  const details = [];
  if (defense > 0) details.push(`Defensa CA-10: -${defense}`);
  if (label) details.push(label);

  return {
    applied,
    modified: defense > 0 || multiplier !== 1 || !!label,
    modifier: details.join(" · ") || null,
    original: amount,
    defended,
    defense,
    multiplier,
    type: damageType
  };
}

export async function applyDamageToActor(targetActor, amount, damageType = "bludgeoning", { homebrew = false, attackTags = [], disableDefense = false } = {}) {
  amount = Math.max(0, safeNum(amount, 0));
  if (!amount) return { applied: 0, modified: false, original: 0, type: damageType };

  const preview = getDamagePreview(targetActor, amount, damageType, { homebrew, attackTags, disableDefense });
  const modifiedAmount = preview.applied;

  const hp = getActorHpData(targetActor);
  let temp = safeNum(hp.temp, 0), value = safeNum(hp.value, 0), remaining = modifiedAmount;

  if (temp > 0) {
    const used = Math.min(temp, remaining);
    temp -= used;
    remaining -= used;
  }
  if (remaining > 0) value = Math.max(0, value - remaining);

  await updateActorHpData(targetActor, { temp, value });

  return { ...preview, applied: modifiedAmount, original: amount, type: damageType };
}

export async function applyHealingToActor(targetActor, amount, type = "healing", { applyCurrent = false } = {}) {
  amount = Math.max(0, safeNum(amount, 0));
  if (!amount) return { applied: 0, original: 0 };
  const hp = getActorHpData(targetActor);

  if (type === "temphp") {
    const currentTemp = safeNum(hp.temp, 0);
    if (amount > currentTemp) {
      await updateActorHpData(targetActor, { temp: amount });
      return { applied: amount, original: amount, isTemp: true };
    }
    return { applied: 0, original: amount, isTemp: true };
  }

  // Temp HP (SUMA) — usado por Aid en esta mesa (y otros boons que suman PG temporales).
  // A diferencia de temphp (RAW), aquí se acumula: hp.temp += amount.
  if (type === "temphpAdd" || String(type||" ").toLowerCase() === "temphpadd") {
    const currentTemp = safeNum(hp.temp, 0);
    const newTemp = currentTemp + amount;
    await updateActorHpData(targetActor, { temp: newTemp });
    return { applied: amount, original: amount, isTemp: true, isTempAdd: true };
  }

  // Temp Max HP (e.g. Aid / boons): modificar tempmax y (opcionalmente) sumar también a hp.value.
  // En dnd5e el path es system.attributes.hp.tempmax (ver issues/estructura value/max/temp/tempmax).
  if (type === "tempmax") {
    const currentTempMax = safeNum(hp.tempmax ?? hp.tempMax, 0);
    const baseMax = safeNum(hp.max, 0);
    const currVal = safeNum(hp.value, 0);
    const newTempMax = currentTempMax + amount;
    const effMax = (baseMax || 0) + newTempMax;

    let newVal = currVal;
    if (applyCurrent) newVal = currVal + amount;
    // Cap a máximo efectivo
    newVal = Math.min(effMax || Number.MAX_SAFE_INTEGER, newVal);

    await updateActorHpData(targetActor, { tempmax: newTempMax, value: newVal });
    return { applied: amount, original: amount, isTempMax: true, applyCurrent };
  }

  const max = safeNum(hp.max, 0);
  const value = safeNum(hp.value, 0);
  const newValue = Math.min(max || Number.MAX_SAFE_INTEGER, value + amount);
  const applied = Math.max(0, newValue - value);
  await updateActorHpData(targetActor, { value: newValue });
  return { applied, original: amount, isTemp: false };
}
