/**
 * Enrutamiento de compatibilidad Foundry VTT 13 ↔ 14.
 * Todo acceso a una API que haya cambiado de nombre o de sitio pasa por aquí;
 * el resto del módulo no pregunta nunca por la versión.
 *
 * | Necesidad            | v13                                   | v14                      |
 * |----------------------|---------------------------------------|--------------------------|
 * | Ventanas y diálogos  | foundry.applications.api (V2)         | igual (V1 en retirada)   |
 * | Enriquecer HTML      | foundry.applications.ux.TextEditor    | igual                    |
 * | Hook de chat         | renderChatMessageHTML (HTMLElement)   | igual                    |
 * | Medir distancias     | canvas.grid.measurePath               | igual                    |
 * | Selector de archivos | foundry.applications.apps.FilePicker  | igual                    |
 */
const f = globalThis.foundry;

export const ApplicationV2 = f.applications.api.ApplicationV2;
export const HandlebarsApplicationMixin = f.applications.api.HandlebarsApplicationMixin;
export const DialogV2 = f.applications.api.DialogV2;

if (![ApplicationV2, HandlebarsApplicationMixin, DialogV2].every((c) => typeof c === "function")) {
  throw new Error("OL Attack necesita las APIs V2 de Foundry 13 o posterior.");
}

/** Se resuelve al usarse: otro módulo puede sustituir la implementación en CONFIG.ux tras cargar. */
export const textEditor = () => f.applications.ux.TextEditor.implementation;
export const filePicker = () => f.applications.apps.FilePicker.implementation;
export const renderTemplate = f.applications.handlebars.renderTemplate;
export const loadTemplates = f.applications.handlebars.loadTemplates;

/** jQuery sigue incluido en 13 y 14; se resuelve en el momento por si algún día se retira. */
export const jq = (el) => (globalThis.jQuery ?? globalThis.$)(el);

/** Generación leída en el momento: `game.release` no existe mientras se evalúa el módulo. */
export function generacion() {
  return Number(game.release?.generation) || Number(String(game.version).split(".")[0]) || 13;
}

/** HTML enriquecido sin avisos de obsolescencia. */
export async function enriquecer(html, options = {}) {
  return textEditor().enrichHTML(String(html ?? ""), options);
}

/** Chat: entrega siempre un HTMLElement, aunque algún módulo reinyecte un envoltorio jQuery. */
export function alRenderizarMensaje(fn) {
  Hooks.on("renderChatMessageHTML", (mensaje, html) => {
    const el = html instanceof HTMLElement ? html : html?.[0];
    if (el) fn(mensaje, el);
  });
}

/** Distancia en unidades de la escena entre dos puntos, con la API de rejilla de 13+. */
export function distanciaEntre(a, b) {
  try {
    return canvas.grid.measurePath([a, b]).distance;
  } catch {
    return NaN;
  }
}
