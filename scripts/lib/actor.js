import { gp, safeNum, ABIL_SET } from "./utils.js";
import { getActorProfValue, getActorLevel, getActorChallenge, getActorClasses, getActorSpellcastingAbility } from "../shared/system-data.js";

export function getActorContext({ actor = null, token = null } = {}) {
  // prioridad: opts
  if (actor) return { actor, token: token ?? null };
  if (token?.actor) return { actor: token.actor, token };

  // token controlado
  const controlled = canvas.tokens?.controlled?.[0];
  if (controlled?.actor) return { actor: controlled.actor, token: controlled };

  // token que el GM ha marcado temporalmente desde el monitor de escena
  if (game.user?.isGM && game.olAttack?.getHandledToken) {
    const handled = game.olAttack.getHandledToken();
    if (handled?.actor) return { actor: handled.actor, token: handled };
  }

  // pj asignado al usuario
  if (game.user?.character) return { actor: game.user.character, token: null };

  return { actor: null, token: null };
}

export const getProfBonus = (actor) => {
  const p = getActorProfValue(actor);
  if (Number.isFinite(p)) return p;
  const lvl = safeNum(getActorLevel(actor), 0);
  if (actor.type === "character") return lvl > 0 ? 2 + Math.floor((lvl - 1) / 4) : 0;
  return 2 + Math.floor(Math.max(0, safeNum(getActorChallenge(actor), 0)) / 4);
};

export const getActivities = (item) => {
  const acts = gp(item, "system.activities");
  if (!acts) return [];
  if (typeof acts.values === "function") return Array.from(acts.values());
  if (Array.isArray(acts.contents)) return acts.contents;
  if (Array.isArray(acts)) return acts;
  if (typeof acts === "object") return Object.values(acts);
  return [];
};

export const normalizeDamageType = (rawTypes, fallback = "bludgeoning") => {
  let t = null;
  if (rawTypes instanceof Set) t = Array.from(rawTypes)[0];
  else if (Array.isArray(rawTypes)) t = rawTypes[0];
  else if (typeof rawTypes === "string") t = rawTypes;
  if (!t) t = fallback;
  return String(t);
};

export const autoAbilityForItem = (item, actor=null) => {
  // SPELL AUTO: Los conjuros deben usar la característica de lanzamiento (no FUE/DES).
  if (item?.type === "spell") {
    const itemAb = String(gp(item, "system.ability") ?? "").toLowerCase();
    if (ABIL_SET.has(itemAb)) return itemAb;

    const actAb = String(getActorSpellcastingAbility(actor) || "").toLowerCase();
    if (ABIL_SET.has(actAb)) return actAb;

    return "cha";
  }

  const acts = getActivities(item);
  const a = acts.find((x) => x?.type === "attack") || acts[0];
  const ab = String(gp(a, "attack.ability") ?? "").toLowerCase();
  if (ABIL_SET.has(ab)) return ab;

  const actionType = String(gp(item, "system.actionType") ?? gp(a, "attack.actionType") ?? gp(a, "attack.type") ?? "").toLowerCase();
  if (/(rwak|rsak|ranged)/i.test(actionType)) return "dex";
  return "str";
};

// ============================
// Bonificadores de daño del actor (Active Effects / Bonos de hoja)
// ============================
// En D&D5e muchos estados/efectos penalizan o bonifican el daño vía system.bonuses.*.damage.
// La macro "homebrew" construye la fórmula a mano, así que necesitamos recoger esos bonos.
// Devuelve una fórmula (string) o "" si no hay nada.
export const getActorDamageBonusFormula = (actor, item) => {
  try {
    if (!actor) return "";
    const bonuses = gp(actor, "system.bonuses") || {};
    const actType = String(gp(item, "system.actionType") || "").toLowerCase();

    let key = "";
    if (actType.includes("mwak")) key = "mwak";
    else if (actType.includes("rwak")) key = "rwak";
    else if (actType.includes("msak")) key = "msak";
    else if (actType.includes("rsak")) key = "rsak";

    // Candidatos típicos (varía según versión)
    const paths = [
      key ? `system.bonuses.${key}.damage` : null,
      "system.bonuses.all.damage",
      "system.bonuses.damage",
      "system.bonuses.weapon.damage",
      "system.bonuses.spell.damage",
      "system.bonuses.mwak.damage",
      "system.bonuses.rwak.damage",
      "system.bonuses.msak.damage",
      "system.bonuses.rsak.damage",
    ].filter(Boolean);

    const seen = new Set();
    const out = [];

    for (const p of paths) {
      const v = gp(actor, p);
      if (typeof v !== "string") continue;
      const s = v.trim();
      if (!s || s === "0") continue;
      if (seen.has(`${p}:${s}`)) continue;
      seen.add(`${p}:${s}`);
      out.push(s);
    }

    // Fallback: algunas hojas meten bonos en claves alternativas dentro de system.bonuses
    // (p.ej. dam.all, dmg.all, etc.). Escaneamos superficialmente.
    const shallow = (obj, prefix = "system.bonuses") => {
      if (!obj || typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        const kk = String(k).toLowerCase();
        if (typeof v === "string" && kk.includes("damage")) {
          const s = v.trim();
          if (s && s !== "0" && !seen.has(`${prefix}.${k}:${s}`)) {
            seen.add(`${prefix}.${k}:${s}`);
            out.push(s);
          }
        }
      }
    };
    shallow(bonuses, "system.bonuses");

    return out.length ? out.join(" + ") : "";
  } catch {
    return "";
  }
};

export const isCombatItem = (item) => {
  if (item.type === "weapon") return true;
  const acts = getActivities(item);
  return acts.some(a => {
    if (!a) return false;
    if (a.type === "attack" || a.type === "damage") return true;
    const dmgParts = gp(a, "damage.parts");
    if (Array.isArray(dmgParts) && dmgParts.length > 0) return true;
    return false;
  });
};

export const getAttackItems = (actor) => {
  return actor.items.filter((i) => {
    if (i.type === "spell") return true;
    if (i.type === "weapon") return true;

    // rasgos con usos
    if (safeNum(gp(i, "system.uses.max"), 0) > 0) return true;

    const acts = getActivities(i);
    if (!acts.length) return false;

    return acts.some((a) => {
      if (!a) return false;
      if (a.type === "attack") return true;
      const dmgParts = gp(a, "damage.parts");
      if (Array.isArray(dmgParts) && dmgParts.length > 0) return true;

      // curación
      let hasHeal = false;
      if (a.type === "heal") hasHeal = true;
      const healParts = gp(a, "healing.parts") ?? gp(a, "heal.parts");
      if (Array.isArray(healParts) && healParts.length > 0) hasHeal = true;
      const hpObj = gp(a, "healing") ?? gp(a, "heal");
      if (hpObj && !Array.isArray(hpObj) && (hpObj.number || hpObj.formula || hpObj.custom?.formula || hpObj.denomination)) hasHeal = true;
      if (hasHeal) return true;

      if (a.type === "save" || !!a.save) return true;
      return false;
    });
  });
};

export const getEquippedWeapons = (actor) => actor.items.filter((i) => i.type === "weapon" && gp(i, "system.equipped") === true);

export const getWeaponDamageType = (weapon) => {
  if (!weapon) return "bludgeoning";
  const acts = getActivities(weapon);
  for (const a of acts) {
    const parts = gp(a, "damage.parts");
    if (Array.isArray(parts) && parts.length > 0) {
      const p = parts[0];
      if (typeof p === "object" && !Array.isArray(p)) {
        const rawTypes = gp(p, "types");
        return normalizeDamageType(rawTypes, gp(p, "type") || "bludgeoning");
      } else if (Array.isArray(p) && p[1]) return p[1];
    }
  }
  return "bludgeoning";
};
