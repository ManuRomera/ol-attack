import { gp, safeNum } from "./utils.js";

const tagToString = (v) => {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    if (typeof v.label === "string") return v.label;
    if (typeof v.name === "string") return v.name;
    if (typeof v.value === "string") return v.value;
    if (typeof v.key === "string") return v.key;
  }
  return null;
};

export function getItemTags(item, activeFeatures = {}) {
  const sys = item?.system ?? {};
  const tags = [];
  const actType = sys.activation?.type;
  if (actType) {
    const raw = CONFIG.DND5E?.activityActivationTypes?.[actType] ?? CONFIG.DND5E?.abilityActivationTypes?.[actType] ?? actType;
    tags.push(tagToString(raw) ?? String(actType));
  }

  if (item?.type === "weapon" || item?.type === "equipment") tags.push(sys.equipped ? "Equipado" : "No equipado");
  if (activeFeatures.castLevel && activeFeatures.castLevel > 0) tags.push(`Nivel ${activeFeatures.castLevel}`);

  if (activeFeatures.rage) tags.push("🔥 Furia");
  if (activeFeatures.reckless) tags.push("⚠️ Temerario");
  if (activeFeatures.frenzy) tags.push("🩸 Frenesí");
  if (activeFeatures.sneak) tags.push("🥷 Furtivo");
  if (activeFeatures.savage) tags.push("⚔️ Salvaje");
  if (activeFeatures.offhand) tags.push("⚔️ Mano Débil");
  if (activeFeatures.wails) tags.push("👻 Lamentos");
  if (activeFeatures.hex) tags.push("🧿 Maldición");
  if (activeFeatures.extraDice) tags.push("✨ Dados extra");

  if (activeFeatures.isHomebrew) tags.push("🛡️ Homebrew");
  else tags.push("✨ Normal");

  return Array.from(new Set(tags.map(tagToString).filter((t) => typeof t === "string" && t.trim().length).map((t) => t.toUpperCase().trim())));
}

export function hasItemUses(item) {
  return safeNum(gp(item, "system.uses.max"), 0) > 0;
}
