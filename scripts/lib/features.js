import { gp, safeNum } from "./utils.js";
import { getItemUses } from "./uses.js";
import { resolveActionProfile } from "./action-profiles.js";

function norm(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function isMultiattackItem(item, actor = null) {
  if (!item) return false;
  const profileKey = String(resolveActionProfile(item, actor)?.profile?.specialFeatureKey || "");
  if (profileKey === "multiattack") return true;

  const hay = [
    item.name,
    gp(item, "system.identifier"),
    gp(item, "system.type.value"),
    gp(item, "system.activation.type"),
    gp(item, "system.description.value")
  ].map(norm).join(" ");

  return hay.includes("multiattack")
    || hay.includes("multiataque")
    || hay.includes("ataque multiple")
    || hay.includes("acciones multiples");
}

export function getActorFeatures(actor) {
  if (!actor) return {};
  const items = actor.items;

  const values = Array.isArray(items?.contents) ? items.contents : Array.from(items || []);
  const findItem = (regex, featureKey = "") => {
    if (featureKey) {
      const viaProfile = values.find((i) => String(resolveActionProfile(i, actor)?.profile?.specialFeatureKey || "") === featureKey);
      if (viaProfile) return viaProfile;
    }
    return values.find((i) => String(i?.name || "").match(regex)) || null;
  };

  const hasRage = !!findItem(/Rage|Furia/i, "rage");
  const hasReckless = !!findItem(/Reckless|Temerario/i, "reckless");
  const hasFrenzy = !!findItem(/Frenzy|Frenesí/i, "frenzy");
  const multiattackItem = values.find((i) => isMultiattackItem(i, actor)) || null;
  const hasMultiattack = !!multiattackItem;
  const rageBonus = safeNum(gp(actor, "system.scale.barbarian.rage-damage"), 2);

  const hasSneak = !!findItem(/Sneak Attack|Ataque Furtivo/i, "sneak");
  let sneakFormula = null;
  let sneakDiceCount = 0;
  const rawSneak = gp(actor, "system.scale.rogue.sneak-attack");
  if (rawSneak && typeof rawSneak === "object" && rawSneak.number) {
    sneakDiceCount = rawSneak.number; sneakFormula = `${rawSneak.number}d${rawSneak.faces}`;
  } else if (typeof rawSneak === "string") {
    sneakFormula = rawSneak; const match = rawSneak.match(/(\d+)d/); if (match) sneakDiceCount = parseInt(match[1]);
  }
  if (!sneakFormula && hasSneak) {
    const rogueClass = items.find((i) => i.type === "class" && (i.system.identifier === "rogue" || i.name.match(/Rogue|Pícaro/i)));
    const levels = rogueClass ? rogueClass.system.levels || 1 : 1;
    sneakDiceCount = Math.ceil(levels / 2); sneakFormula = sneakDiceCount + "d6";
  }
  if (!sneakFormula) sneakFormula = "0";

  const wailsItem = findItem(/Wails from the Grave|Lamentos\s+desde\s+la\s+tumba|Lamentos\s+de\s+la\s+tumba/i, "wails");
  const hasWails = !!wailsItem;
  let wailsFormula = "0";
  if (hasWails && sneakDiceCount > 0) {
    const wailsDice = Math.ceil(sneakDiceCount / 2);
    wailsFormula = wailsDice > 0 ? `${wailsDice}d6` : "0";
  }
  const wailsUses = hasWails ? getItemUses(wailsItem) : { max: 0, remaining: 0 };

  const hasSavage = !!findItem(/Savage Attacker|Atacante Salvaje/i, "savage");

  return {
    hasRage,
    hasReckless,
    hasFrenzy,
    hasMultiattack,
    multiattackItemId: multiattackItem?.id ?? null,
    rageBonus,
    hasSneak,
    sneakFormula,
    hasSavage,
    hasWails,
    wailsFormula,
    wailsItemId: wailsItem?.id ?? null,
    wailsUses: { max: wailsUses.max ?? 0, remaining: wailsUses.remaining ?? 0 }
  };
}
