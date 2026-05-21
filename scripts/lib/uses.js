import { gp, safeNum } from "./utils.js";

/**
 * D&D5e v13+: `system.uses.max` puede ser una fórmula (p.ej. "@abilities.cha.mod").
 * Si no resolvemos eso, rasgos como Inspiración Bárdica aparecen con max=0 y no se consumen.
 */
function _resolveUsesNumber(item, raw, fallback = 0) {
  if (raw == null) return fallback;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;

  const s = String(raw).trim();
  if (!s) return fallback;

  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;

  // Intentar resolver fórmulas tipo "@abilities.cha.mod" de forma segura y síncrona.
  try {
    const actor = item?.actor ?? item?.parent ?? null;
    const rd = actor && typeof actor.getRollData === "function" ? actor.getRollData() : {};

    let expr = s;
    try {
      if (typeof Roll?.replaceFormulaData === "function") {
        expr = Roll.replaceFormulaData(s, rd, { missing: 0, warn: false });
      } else {
        expr = s.replace(/@([\w.]+)/g, (m, p) => {
          const v = foundry.utils.getProperty(rd, p);
          return (v == null || v === "") ? 0 : v;
        });
      }
    } catch {
      expr = s;
    }

    const cleaned = String(expr).trim();

    const n2 = Number(cleaned);
    if (Number.isFinite(n2)) return n2;

    // Rechazar cualquier cosa que parezca código (esto NO es input del usuario, pero mejor ser estrictos)
    if (/[;{}=]/.test(cleaned) || /(globalThis|window|document|Function|constructor|eval|game|foundry)/i.test(cleaned)) {
      return fallback;
    }

    // Permitir algunas funciones matemáticas comunes usadas en fórmulas de dnd5e
    const scope = {
      max: Math.max,
      min: Math.min,
      floor: Math.floor,
      ceil: Math.ceil,
      round: Math.round,
      abs: Math.abs
    };

    const fn = Function(...Object.keys(scope), `"use strict"; return (${cleaned});`);
    const total = fn(...Object.values(scope));
    if (Number.isFinite(Number(total))) return Number(total);

    if (typeof Roll?.safeEval === "function") {
      const t = Roll.safeEval(cleaned);
      if (Number.isFinite(Number(t))) return Number(t);
    }
  } catch {}

  return fallback;
}


/**
 * D&D5e v13: algunos items usan system.uses.value, otros system.uses.spent.
 * Normalizamos ambos para mostrar/consumir correctamente.
 */
export function getItemUses(item) {
  const uses = gp(item, "system.uses") || {};
  const max = Math.max(0, Math.floor(_resolveUsesNumber(item, uses.max, 0)));
  if (max <= 0) return { max: 0, remaining: 0, spent: 0, schema: "none" };

  const value = uses.value;
  const spent = uses.spent;

  if (Number.isFinite(Number(value)) || (typeof value === "string" && value.trim() !== "")) {
    const remaining = Math.max(0, Math.floor(_resolveUsesNumber(item, value, 0)));
    return { max, remaining, spent: Math.max(0, max - remaining), schema: "value" };
  }
  if (Number.isFinite(Number(spent)) || (typeof spent === "string" && spent.trim() !== "")) {
    const sp = Math.max(0, Math.floor(_resolveUsesNumber(item, spent, 0)));
    return { max, remaining: Math.max(0, max - sp), spent: sp, schema: "spent" };
  }
  return { max, remaining: 0, spent: max, schema: "unknown" };
}

export async function consumeItemUse(item, amount = 1) {
  const u = getItemUses(item);
  if (u.max <= 0) return { ok: false, reason: "no-uses", ...u };
  const amt = Math.max(1, Math.floor(Number(amount) || 1));

  if (u.schema === "value") {
    const cur = safeNum(gp(item, "system.uses.value"), 0);
    if (cur <= 0) return { ok: false, reason: "empty", ...u };
    const next = Math.max(0, cur - amt);
    const update = { "system.uses.value": next };
    const hasSpent = gp(item, "system.uses.spent");
    if (Number.isFinite(Number(hasSpent))) update["system.uses.spent"] = Math.max(0, u.max - next);
    await item.update(update);
    return { ok: true, max: u.max, remaining: next, spent: Math.max(0, u.max - next), schema: "value" };
  }

  if (u.schema === "spent") {
    const cur = safeNum(gp(item, "system.uses.spent"), 0);
    if (cur >= u.max) return { ok: false, reason: "empty", ...u };
    const next = Math.min(u.max, cur + amt);
    const update = { "system.uses.spent": next };
    const hasValue = gp(item, "system.uses.value");
    if (Number.isFinite(Number(hasValue))) update["system.uses.value"] = Math.max(0, u.max - next);
    await item.update(update);
    return { ok: true, max: u.max, remaining: Math.max(0, u.max - next), spent: next, schema: "spent" };
  }

  // intento value/spent
  const curVal = gp(item, "system.uses.value");
  if (Number.isFinite(Number(curVal))) {
    const next = Math.max(0, safeNum(curVal, 0) - amt);
    const update = { "system.uses.value": next };
    const hasSpent = gp(item, "system.uses.spent");
    if (Number.isFinite(Number(hasSpent))) update["system.uses.spent"] = Math.max(0, u.max - next);
    await item.update(update);
    return { ok: true, max: u.max, remaining: next, spent: Math.max(0, u.max - next), schema: "value" };
  }
  const curSpent = gp(item, "system.uses.spent");
  if (Number.isFinite(Number(curSpent))) {
    const next = Math.min(u.max, safeNum(curSpent, 0) + amt);
    const update = { "system.uses.spent": next };
    const hasValue = gp(item, "system.uses.value");
    if (Number.isFinite(Number(hasValue))) update["system.uses.value"] = Math.max(0, u.max - next);
    await item.update(update);
    return { ok: true, max: u.max, remaining: Math.max(0, u.max - next), spent: next, schema: "spent" };
  }

  return { ok: false, reason: "unknown-schema", ...u };
}
