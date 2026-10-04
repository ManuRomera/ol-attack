import { i18n } from "../shared/i18n.js";
import { shouldShowSheetButtonsForCurrentSystem, shouldShowTokenHudForCurrentSystem } from "../shared/system-data.js";

/**
 * Puntos de entrada de OL Attack:
 *  - un icono en la cabecera de las hojas de actor (ApplicationV2, como las de dnd5e 5.x),
 *    junto a los demás controles de ventana;
 *  - un botón en el HUD del token.
 * Los hooks de cabecera de hojas V1 y `html.find` en el HUD ya no funcionan en Foundry 13.
 */
export function registerSheetButtons() {
  Hooks.on("renderApplicationV2", (app, element) => {
    if (app.document?.documentName !== "Actor" || !app.hasFrame) return;
    if (!shouldShowSheetButtonsForCurrentSystem()) return;
    const cab = element.querySelector(".window-header");
    if (!cab || cab.querySelector(".ol-attack-open")) return;
    const b = document.createElement("button");
    b.type = "button";
    // Las clases de icono van en el propio botón, como en el resto de controles de la cabecera.
    b.className = "header-control icon fa-solid fa-burst ol-attack-open";
    b.dataset.tooltip = i18n("OLATTACK.Open");
    b.setAttribute("aria-label", i18n("OLATTACK.Open"));
    b.addEventListener("click", (ev) => { ev.stopPropagation(); game.olAttack?.open({ actor: app.document }); });
    const ancla = cab.querySelector('[data-action="toggleControls"]') ?? cab.querySelector('[data-action="close"]');
    if (ancla) ancla.before(b); else cab.append(b);
  });

  Hooks.on("renderTokenHUD", (hud, element) => {
    if (!shouldShowTokenHudForCurrentSystem()) return;
    const izquierda = element.querySelector(".col.left");
    if (!izquierda || izquierda.querySelector(".ol-attack-hud")) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "control-icon ol-attack-hud";
    b.dataset.tooltip = i18n("OLATTACK.Open");
    b.setAttribute("aria-label", i18n("OLATTACK.Open"));
    b.innerHTML = '<i class="fa-solid fa-burst" inert></i>';
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const token = hud.object;
      game.olAttack?.open({ token, actor: token?.actor });
    });
    izquierda.append(b);
  });
}
