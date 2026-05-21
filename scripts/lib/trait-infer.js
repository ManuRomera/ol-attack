import { gp, safeNum } from "./utils.js";

const stripHtml = (html) => String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const normDie = (raw) => {
  const s = String(raw || "").trim();
  if (!s) return "";
  // d6 -> 1d6
  if (/^d\d+$/i.test(s)) return `1${s}`;
  return s;
};

function getClassLevel(actor, ident) {
  try {
    const items = actor?.items;
    const cls = items?.find?.((i) => i?.type === "class" && (
      String(gp(i, "system.identifier") || "").toLowerCase() === ident ||
      String(i?.name || "").toLowerCase().includes(ident)
    ));
    return safeNum(gp(cls, "system.levels") ?? gp(cls, "system.level") ?? 0, 0);
  } catch {
    return 0;
  }
}

function getBardicInspirationDie(actor) {
  // 2014/2024: d6 (1-4), d8 (5-9), d10 (10-14), d12 (15+)
  const lvl = getClassLevel(actor, "bard") || safeNum(gp(actor, "system.classes.bard.system.levels"), 0);
  const faces = lvl >= 15 ? 12 : lvl >= 10 ? 10 : lvl >= 5 ? 8 : 6;
  return `1d${faces}`;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
}

export function inferBonusDie(item, actor) {
  if (!item) return null;
  const name = String(item.name || "").toLowerCase();
  const ident = String(gp(item, "system.identifier") || "").toLowerCase();
  const normName = normalizeName(item.name || "");
  const desc = stripHtml(gp(item, "system.description.value") || gp(item, "system.description.chat") || "");
  const descL = desc.toLowerCase();

  // Si el rasgo habla de "reducir daño" y tirar un dado, NO es un bonus-die (es una tirada propia de reducción).
  if (/(reduce|reducir|reduce el|reducir el|reduction)\s+(?:\w+\s+){0,4}(damage|daño)/i.test(desc)) return null;

  // Casos canónicos. OJO: aquí usamos coincidencias exactas o identificadores robustos.
  // Evitamos falsos positivos como "Saeta guía", que antes coincidía por contener "guía".
  const isBardicInspiration = ident.includes("bardic") || ["bardic-inspiration", "inspiracion-bardica", "inspiracion-bardica-mejorada"].includes(normName);
  const isBless = ["bless", "bendicion", "bendicion-mejorada"].includes(ident) || ["bless", "bendicion"].includes(normName);
  const isGuidance = ["guidance", "guia"].includes(ident) || ["guidance", "guia"].includes(normName);
  const isResistanceCantrip = ["resistance", "resistencia"].includes(ident) || ["resistance", "resistencia"].includes(normName);

  if (isBardicInspiration) {
    return { formula: getBardicInspirationDie(actor), label: item.name };
  }
  if (isBless) {
    return { formula: "1d4", label: item.name };
  }
  if (isGuidance) {
    return { formula: "1d4", label: item.name };
  }
  if (isResistanceCantrip && item.type === "spell") {
    return { formula: "1d4", label: item.name };
  }

  // system.formula (algunos rasgos lo traen aquí)
  const sysFormula = String(gp(item, "system.formula") || "").trim();
  const mSys = sysFormula.match(/\b(\d+)?d(4|6|8|10|12|20)\b/i) || sysFormula.match(/\bd(4|6|8|10|12|20)\b/i);
  if (mSys) {
    return { formula: normDie(mSys[0]), label: item.name };
  }

  // Inferir desde descripción: buscamos un dado y texto de "añadir/sumar".
  const m = descL.match(/\b(\d+)?d(4|6|8|10|12|20)\b/i) || descL.match(/\bd(4|6|8|10|12|20)\b/i);
  if (m) {
    const die = normDie(m[0]);
    const addCtx = /(añad|añad[ei]r|sum|suma|add|adding|added|bonus)\b/.test(descL);
    const rollCtx = /(tirad|tirada|roll)\b/.test(descL);
    if (addCtx && rollCtx) return { formula: die, label: item.name };
  }

  return null;
}

export function inferAutoEffectRoll(item) {
  if (!item) return null;
  const name = String(item.name || "").toLowerCase();
  const desc = stripHtml(gp(item, "system.description.value") || gp(item, "system.description.chat") || "");
  const dL = desc.toLowerCase();

  // Piel de piedra / Stone's Endurance (d12 + Con) — detectamos por el patrón de "reduce daño" + dado.
  const reduceCtx = /(reduce|reduce el|reducir|reducir el|reducen|reduction|reduce the)\s+(?:\w+\s+){0,3}(damage|daño)/i.test(desc);
  const hasStoneKey = name.includes("giant ancestry") || name.includes("ancestr") || name.includes("stone") || name.includes("piedra") || /stone's endurance|resistencia.*piedra|piel de piedra/i.test(desc);

  if (reduceCtx || hasStoneKey) {
    const mDie = dL.match(/\b(\d+)?d\d+\b/i) || dL.match(/\bd\d+\b/i);
    if (!mDie) return null;
    const die = normDie(mDie[0]);
    let formula = die;
    if (/constitution|constitución|constitucion/i.test(dL)) formula = `${die} + @abilities.con.mod`;
    return { formula, label: "Reducción de daño" };
  }

  return null;
}
