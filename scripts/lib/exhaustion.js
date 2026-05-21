import { gp } from "./utils.js";

const EXHAUSTION_KEYS = ["exhaustion", "agotamiento", "cansancio", "fatigue", "fatigued", "exhaust", "agot", "fatig"];

const _hasKey = (haystack = "", key = "") => {
  const h = String(haystack || "").toLowerCase();
  const k = String(key || "").toLowerCase();
  if (!h || !k) return false;
  return h === k || h.startsWith(k);
};

export function getExhaustionInfo(actor) {
  // En algunos mundos el cansancio es "apilable" vía múltiples ActiveEffects (1+1+1...)
  // y NO actualiza system.attributes.exhaustion. En otros, viene como un solo valor (3, 4...).
  // Estrategia:
  //  - Si hay un valor numérico en atributos -> lo usamos como fuente principal.
  //  - Si no, y hay varios efectos y TODOS son 1 -> sumamos (stack).
  //  - Si hay un efecto con valor > 1 -> tomamos el máximo (no sumamos para evitar doble conteo).
  let best = { level: 0, source: "none" };
  const considerMax = (lvl, source) => {
    const n = Number(lvl);
    if (!Number.isFinite(n)) return;
    if (n > best.level) best = { level: n, source };
  };

  const attrPaths = [
    "system.attributes.exhaustion",
    "system.attributes.exhaustion.value",
    "system.attributes.exhaustion.level",
    "system.attributes.exhaustionLevel",
    "system.attributes.fatigue",
    "system.attributes.fatigue.value"
  ];
  for (const p of attrPaths) considerMax(gp(actor, p), p);

  try {
    const effects = Array.from(actor?.effects ?? []);
    const effVals = [];
    for (const ef of effects) {
      const statuses = ef?.statuses ? Array.from(ef.statuses).map((s) => String(s).toLowerCase()) : [];
      const statusId = String((typeof ef?.getFlag === "function" ? ef.getFlag("core", "statusId") : null) ?? gp(ef, "flags.core.statusId") ?? "").toLowerCase();
      const nm = String(ef?.name ?? "").toLowerCase();
      const hasExh = EXHAUSTION_KEYS.some((k) => statuses.some((s) => _hasKey(s, k)) || _hasKey(statusId, k) || nm.includes(k));
      if (hasExh) {
        let val = gp(ef, "flags.core.statusValue") ?? gp(ef, "flags.core.value") ?? gp(ef, "flags.dnd5e.level") ?? gp(ef, "flags.dnd5e.exhaustion") ?? gp(ef, "flags.world.value");
        let nVal = Number(val);
        if (!Number.isFinite(nVal)) {
          // Algunos módulos usan statusId/name tipo "exhaustion2" o "Cansancio 2"
          const m = String(statusId || "").match(/(\d+)/) || String(nm || "").match(/(\d+)/);
          nVal = m ? Number(m[1]) : 1;
        }
        effVals.push({ val: Number.isFinite(nVal) ? nVal : 1, name: ef?.name || ef?.id || "unknown" });
      }
    }

    if (effVals.length) {
      const vals = effVals.map((x) => (Number.isFinite(x.val) ? x.val : 1));
      let effLevel = 0;
      if (vals.length === 1) effLevel = vals[0];
      else if (vals.every((v) => v === 1)) effLevel = vals.length; // stack 1+1+1...
      else effLevel = Math.max(...vals); // evita sumar si hay un nivel explícito

      // Si atributos ya traían un número, respetamos el mayor (por si están sincronizados)
      if (Number.isFinite(best.level) && best.level > 0) {
        best = { level: Math.max(best.level, effLevel), source: best.source };
      } else {
        best = { level: effLevel, source: `effects:${effVals.map((x) => x.name).join(",")}` };
      }
    }
  } catch {}

  const level = Math.max(0, Math.floor(best.level));
  return { level, penalty: level * 2, source: best.source };
}
