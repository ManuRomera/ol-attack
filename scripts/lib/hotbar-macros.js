import { MODULE_ID } from "../shared/constants.js";

const MACROS = [
  {
    key: "open-ol-attack",
    slot: 1,
    name: "OL Attack",
    img: "icons/svg/sword.svg",
    command: `game.olAttack?.open?.();`
  },
  {
    key: "open-combat-monitor",
    slot: 2,
    name: "OL Monitor de combate",
    img: "icons/svg/combat.svg",
    command: `game.olAttack?.openSceneTracker?.({ displayMode: "combat" });`
  }
];

function findExistingMacro(key, name) {
  return game.macros?.find?.((macro) => macro.getFlag?.(MODULE_ID, "hotbarMacro") === key)
    || game.macros?.find?.((macro) => macro.name === name)
    || null;
}

async function ensureMacro(def) {
  const existente = findExistingMacro(def.key, def.name);
  if (existente) return existente;
  // Crear macros de guion exige permiso; sin él no se insiste (ni se avisa a cada inicio de sesión).
  if (!game.user?.can?.("MACRO_SCRIPT")) return null;
  try {
    return await Macro.create({
      name: def.name, type: "script", img: def.img, command: def.command,
      flags: { [MODULE_ID]: { hotbarMacro: def.key } }
    }, { renderSheet: false });
  } catch (err) {
    console.warn("[ol-attack] No se pudo crear macro de hotbar", def.name, err);
    return null;
  }
}

/**
 * Crea (una vez) las macros del módulo y las coloca en los huecos 1 y 2 de la barra rápida,
 * pero solo si el hueco está libre: no pisa las macros que cada persona ya tuviera allí.
 * Se puede desactivar en los ajustes del módulo.
 */
export async function installHotbarMacros() {
  if (!game.settings.get(MODULE_ID, "installMacros")) return;
  for (const def of MACROS) {
    const macro = await ensureMacro(def);
    if (!macro) continue;
    const ocupante = game.user?.hotbar?.[def.slot];
    if (ocupante) continue;
    try {
      await game.user?.assignHotbarMacro?.(macro, def.slot);
    } catch (err) {
      console.warn("[ol-attack] No se pudo asignar macro a la barra rapida", def.name, err);
    }
  }
}
