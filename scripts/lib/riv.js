import { getActorTraitEntry } from "../shared/system-data.js";
import { gp } from "./utils.js";

export const BYPASS_CANON = (raw) => {
  const s = String(raw ?? "").toLowerCase().trim();
  if (!s) return null;
  if (["mgc", "magical", "magic", "mágico", "magico"].includes(s)) return "mgc";
  if (["sil", "silver", "silvered", "plateado", "plata"].includes(s)) return "sil";
  if (["ada", "adamant", "adamantine", "adamantio"].includes(s)) return "ada";
  if (["mgc", "sil", "ada"].includes(s)) return s;
  return null;
};

export const toSet = (v) => {
  if (!v) return new Set();
  if (v instanceof Set) return new Set(Array.from(v).map(String));
  if (Array.isArray(v)) return new Set(v.map(String));
  if (typeof v === "string") return new Set(v.split(/[,;|]/g).map((x) => x.trim()).filter(Boolean));
  if (typeof v === "object" && Array.isArray(v.value)) return new Set(v.value.map(String));
  return new Set();
};

export const firstIntersection = (aSet, bSet) => {
  for (const a of aSet) if (bSet.has(a)) return a;
  return null;
};

export const bypassLabel = (tag) => {
  if (tag === "mgc") return "Mágico";
  if (tag === "sil") return "Plateado";
  if (tag === "ada") return "Adamantio";
  return String(tag || "");
};

export const getTraitBypasses = (actor, traitKey) => {
  const entry = getActorTraitEntry(actor, traitKey);
  const raw = gp(entry, `bypasses`);
  const rawValue = gp(entry, `bypasses.value`);
  const set = new Set();

  const addB = (v) => {
    if (!v) return;
    if (v instanceof Set) v.forEach(x => set.add(String(x)));
    else if (Array.isArray(v)) v.forEach(x => set.add(String(x)));
    else if (typeof v === "object" && v.value) addB(v.value);
    else if (typeof v === "string") set.add(v);
  };

  addB(raw); addB(rawValue);

  const out = new Set();
  for (const x of set) {
    const c = BYPASS_CANON(x);
    if (c) out.add(c);
  }
  return out;
};

export const getAttackBypassTags = (item) => {
  const out = new Set();
  if (!item) return out;
  if (item.type === "spell") out.add("mgc");

  const props = gp(item, "system.properties");
  if (props) {
    const propArray = props instanceof Set ? Array.from(props) : Array.isArray(props) ? props : Object.keys(props).filter(k => props[k]);
    for (const p of propArray) {
      const c = BYPASS_CANON(p);
      if (c) out.add(c);
    }
  }

  if (gp(item, "system.magical") === true) out.add("mgc");

  const mat = String(gp(item, "system.materials.value") ?? gp(item, "system.material.value") ?? gp(item, "system.material") ?? "").toLowerCase();
  if (mat.includes("adamant")) out.add("ada");
  if (mat.includes("silver") || mat.includes("plata") || mat.includes("platead")) out.add("sil");
  if (mat.includes("magic") || mat.includes("mágic") || mat.includes("magico")) out.add("mgc");

  return out;
};

export const traitHasType = (traitSet, dmgType) => {
  if (traitSet.has(dmgType)) return true;
  const phys = new Set(["bludgeoning", "piercing", "slashing"]);
  if (phys.has(dmgType) && (traitSet.has("physical") || traitSet.has("phys"))) return true;
  return false;
};
