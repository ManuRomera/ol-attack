export const gp = foundry.utils.getProperty;

export const safeNum = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

// Base sanitization used for *damage base formulas* when we add ability/prof ourselves (Homebrew).
export const sanitizeFormula = (f) =>
  String(f ?? "")
    .replace(/@mod\b/g, "0")
    .replace(/@prof\b/g, "0")
    .replace(/@abilities\.\w+\.mod\b/g, "0")
    .replace(/@bonuses\.[\w.]+/g, "0")
    .trim();


// Loose sanitization: keep @mod/@prof etc so D&D5e rollData can resolve them (Heroism, Cure Wounds, etc.).
// We only neutralize @bonuses.* which can be noisy across sheets.
export const sanitizeFormulaLoose = (f) =>
  String(f ?? "")
    .replace(/@bonuses\.[\w.]+/g, "0")
    .trim();

export const cleanDiceBonus = (f) => {
  const s = sanitizeFormula(f);
  return s ? s : "";
};

export const makeStableKey = (raw) => {
  const s = String(raw ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `k${Math.abs(h)}`;
};

export async function enrichDescription(item, actor) {
  try {
    const html = await TextEditor.enrichHTML(item?.system?.description?.value ?? "", { secrets: item?.isOwner });
    return html || "";
  } catch {
    return item?.system?.description?.value ?? "";
  }
}

export const ABIL_SET = new Set(["str", "dex", "con", "int", "wis", "cha"]);

export const translateAbility = (abl) => CONFIG.DND5E?.abilities?.[abl]?.label || abl;
export const translateDamageType = (type) => {
  const t = String(type || "").toLowerCase();
  if (t === "healing") return "Curación";
  if (t === "temphp" || t === "temphpadd" || t.includes("temp")) return "PG Temporales";
  if (t === "tempmax") return "PG Máx (temp)";
  return CONFIG.DND5E?.damageTypes?.[type]?.label || (type || "Daño");
};
