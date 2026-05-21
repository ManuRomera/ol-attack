import { buildSpellSlotValuePath, getActorSpellSlots } from "../shared/system-data.js";
import { gp, safeNum } from "./utils.js";

// ============================================================
// Spell Level helper (D&D5e v13+)
// En algunas versiones/sources, system.level puede ser número o un objeto.
// Esta función lo normaliza para que el menú de upcast y el cálculo funcionen.
// ============================================================
export const getSpellLevel = (item) => {
  try {
    const raw = gp(item, "system.level");
    if (Number.isFinite(Number(raw))) return safeNum(raw, 0);
    if (raw && typeof raw === "object") {
      // posibles keys: value / level / base
      return safeNum(raw.value ?? raw.level ?? raw.base ?? 0, 0);
    }
    return 0;
  } catch {
    return 0;
  }
};

export const getAvailableSpellSlots = (actor) => {
  const spells = getActorSpellSlots(actor) || {};
  const slots = [];
  for (let i = 1; i <= 9; i++) {
    const data = spells[`spell${i}`];
    if (data && data.max > 0) {
      slots.push({
        key: `spell${i}`,
        level: i,
        value: safeNum(data.value, 0),
        max: safeNum(data.max, 0),
        label: `Nivel ${i} (${safeNum(data.value, 0)}/${safeNum(data.max, 0)})`
      });
    }
  }
  const pact = spells.pact;
  if (pact && pact.max > 0 && pact.level > 0) {
    slots.push({
      key: "pact",
      level: pact.level,
      value: safeNum(pact.value, 0),
      max: safeNum(pact.max, 0),
      label: `Pacto Nivel ${pact.level} (${safeNum(pact.value, 0)}/${safeNum(pact.max, 0)})`
    });
  }
  return slots.sort((a, b) => a.level - b.level);
};

export const hasMagicActor = (actor) => {
  const anySpells = actor.items?.some?.((i) => i.type === "spell") ?? false;
  const slots = getAvailableSpellSlots(actor).some((s) => s.max > 0);
  return !!(anySpells || slots);
};

export async function consumeSpellSlot(actor, slotKey) {
  if (!slotKey) return { ok: false, reason: "no-slotKey" };
  const slotPath = buildSpellSlotValuePath(slotKey);
  const currentSlots = gp(actor, slotPath);
  if (!Number.isFinite(Number(currentSlots))) return { ok: false, reason: "bad-path" };
  if (currentSlots <= 0) return { ok: false, reason: "empty" };
  await actor.update({ [slotPath]: currentSlots - 1 });
  return { ok: true, remaining: currentSlots - 1 };
}
