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
    command: `
const app = game.olAttack?.openSceneTracker?.({ displayMode: "combat" });
if (game.user?.isGM && app) {
  app.displayMode = "combat";
  app.render(true);
}
`.trim()
  }
];

function findExistingMacro(key, name) {
  return game.macros?.find?.((macro) => macro.getFlag?.(MODULE_ID, "hotbarMacro") === key)
    || game.macros?.find?.((macro) => macro.name === name)
    || null;
}

async function ensureMacro(def) {
  let macro = findExistingMacro(def.key, def.name);
  const data = {
    name: def.name,
    type: "script",
    img: def.img,
    command: def.command,
    flags: {
      [MODULE_ID]: {
        hotbarMacro: def.key
      }
    }
  };

  if (macro) {
    try {
      if (macro.isOwner || game.user?.isGM) {
        await macro.update(data);
      }
    } catch (_) {}
    return macro;
  }

  try {
    macro = await Macro.create(data, { renderSheet: false });
  } catch (err) {
    console.warn("[ol-attack] No se pudo crear macro de hotbar", def.name, err);
  }

  return macro;
}

export async function installHotbarMacros() {
  for (const def of MACROS) {
    const macro = await ensureMacro(def);
    if (!macro) continue;
    try {
      await game.user?.assignHotbarMacro?.(macro, def.slot);
    } catch (err) {
      console.warn("[ol-attack] No se pudo asignar macro a la barra rapida", def.name, err);
    }
  }
}
