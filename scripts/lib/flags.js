/**
 * Acceso a flags del módulo.
 *
 * Los flags viven bajo `flags.ol-attack` (id completo del módulo). Hasta la 0.1.x vivían bajo el
 * ámbito genérico `world`; se siguen leyendo como respaldo y el GM los traslada una sola vez
 * (`migrarFlagsAntiguos`), de modo que nada se pierde si el GM aún no ha entrado.
 */
import {
  MODULE_ID, FLAG_SCOPE, FLAG_SCOPE_LEGACY, FLAG_KEY, FLAG_CARD, SETTING_FLAGS_MIGRATED,
  FLAG_PREFS, FLAG_VISIBLE, FLAG_OFFHAND_ENABLED, FLAG_OFFHAND_WEAPON, FLAG_AUTO_CLOSE,
  FLAG_RASGOS_EXTRA_DICE, FLAG_CONCENTRATION, FLAG_ACTION_PROFILE_OVERRIDE
} from "../shared/constants.js";

const leerCrudo = (doc, scope, key) => {
  try { return doc?.getFlag?.(scope, key); } catch { return undefined; }
};

/** Lee un flag del módulo; si no existe, el del ámbito antiguo. */
export function leerFlag(doc, key) {
  const nuevo = leerCrudo(doc, FLAG_SCOPE, key);
  return nuevo !== undefined ? nuevo : leerCrudo(doc, FLAG_SCOPE_LEGACY, key);
}

export const escribirFlag = (doc, key, value) => doc.setFlag(FLAG_SCOPE, key, value);

export async function borrarFlag(doc, key) {
  if (leerCrudo(doc, FLAG_SCOPE, key) !== undefined) await doc.unsetFlag(FLAG_SCOPE, key);
  if (leerCrudo(doc, FLAG_SCOPE_LEGACY, key) !== undefined) await doc.unsetFlag(FLAG_SCOPE_LEGACY, key);
}

/** Datos de la tarjeta de chat de un mensaje (con respaldo al formato antiguo). */
export function datosTarjeta(message) {
  return leerCrudo(message, FLAG_SCOPE, FLAG_CARD) ?? leerCrudo(message, FLAG_SCOPE_LEGACY, FLAG_KEY) ?? {};
}

export const guardarTarjeta = (message, data) => message.setFlag(FLAG_SCOPE, FLAG_CARD, data);

/** Estructura de flags para ChatMessage.create(). */
export const flagsTarjeta = (data) => ({ [FLAG_SCOPE]: { [FLAG_CARD]: data } });

const CLAVES = [
  FLAG_PREFS, FLAG_VISIBLE, FLAG_OFFHAND_ENABLED, FLAG_OFFHAND_WEAPON, FLAG_AUTO_CLOSE,
  FLAG_RASGOS_EXTRA_DICE, FLAG_CONCENTRATION, FLAG_ACTION_PROFILE_OVERRIDE
];

function cambiosDe(doc) {
  const viejos = doc.flags?.[FLAG_SCOPE_LEGACY];
  if (!viejos) return null;
  const cambios = {};
  for (const k of CLAVES) {
    if (viejos[k] === undefined) continue;
    if (doc.flags?.[FLAG_SCOPE]?.[k] === undefined) cambios[`flags.${FLAG_SCOPE}.${k}`] = viejos[k];
    cambios[`flags.${FLAG_SCOPE_LEGACY}.-=${k}`] = null;
  }
  return Object.keys(cambios).length ? cambios : null;
}

/** El GM traslada los flags de actores y objetos al ámbito del módulo. Una sola vez por mundo. */
export async function migrarFlagsAntiguos() {
  if (!game.user?.isGM || game.settings.get(MODULE_ID, SETTING_FLAGS_MIGRATED)) return;
  let movidos = 0;
  try {
    const actores = [];
    for (const actor of game.actors) {
      const c = cambiosDe(actor);
      if (c) actores.push({ _id: actor.id, ...c });
      const objetos = actor.items.map((i) => { const ci = cambiosDe(i); return ci ? { _id: i.id, ...ci } : null; }).filter(Boolean);
      if (objetos.length) { await actor.updateEmbeddedDocuments("Item", objetos); movidos += objetos.length; }
    }
    if (actores.length) { await Actor.updateDocuments(actores); movidos += actores.length; }
    const sueltos = game.items.map((i) => { const c = cambiosDe(i); return c ? { _id: i.id, ...c } : null; }).filter(Boolean);
    if (sueltos.length) { await Item.updateDocuments(sueltos); movidos += sueltos.length; }
    await game.settings.set(MODULE_ID, SETTING_FLAGS_MIGRATED, true);
    if (movidos) console.log(`${MODULE_ID} | Flags trasladados al ámbito del módulo en ${movidos} documentos.`);
  } catch (error) {
    console.warn(`${MODULE_ID} | No se pudieron migrar los flags antiguos (se seguirán leyendo del ámbito antiguo).`, error);
  }
}
