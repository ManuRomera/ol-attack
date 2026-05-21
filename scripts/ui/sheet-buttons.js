import { i18n } from "../shared/i18n.js";
import { shouldShowSheetButtonsForCurrentSystem, shouldShowTokenHudForCurrentSystem } from "../shared/system-data.js";

export function registerSheetButtons() {
  Hooks.on("getActorSheetHeaderButtons", (app, buttons) => {
    if (!app?.actor) return;
    if (!shouldShowSheetButtonsForCurrentSystem()) return;

    buttons.unshift({
      label: "OL Attack",
      class: "ol-attack-open",
      icon: "fas fa-burst",
      onclick: () => game.olAttack?.open({ actor: app.actor })
    });
  });

  Hooks.on("renderTokenHUD", (hud, html, data) => {
    if (!shouldShowTokenHudForCurrentSystem()) return;
    const btn = $(`
      <div class="control-icon ol-attack-hud" title="${i18n("OLATTACK.Open")}">
        <i class="fas fa-burst"></i>
      </div>`);
    btn.on("click", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const token = canvas.tokens?.get(data._id);
      game.olAttack?.open({ token, actor: token?.actor });
    });
    html.find(".left").append(btn);
  });
}
