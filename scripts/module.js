import { MODULE_ID, SOCKET_NS } from "./shared/constants.js";
import { loadTemplates } from "./shared/compat.js";
import { registerSettings } from "./shared/settings.js";
import { registrarAccesibilidad } from "./lib/accesibilidad.js";
import { registrarRetratos } from "./lib/retrato.js";
import { migrarFlagsAntiguos } from "./lib/flags.js";
import { registerSocket } from "./socket/socket.js";
import { registerSheetButtons } from "./ui/sheet-buttons.js";
import { registerChatHandlers } from "./chat/chat-handlers.js";
import { registerDamageLedger } from "./lib/damage-ledger.js";
import { installHotbarMacros } from "./lib/hotbar-macros.js";
import { OLAttackAPI } from "./api.js";

Hooks.once("init", () => {
  registerSettings();
  registrarAccesibilidad();
  loadTemplates([
    `modules/${MODULE_ID}/templates/ol-attack-app.hbs`,
    `modules/${MODULE_ID}/templates/scene-tracker-app.hbs`,
    `modules/${MODULE_ID}/templates/scene-tracker-player-app.hbs`,
    `modules/${MODULE_ID}/templates/partials/scene-card.hbs`
  ]);
  // Exponer API
  game.olAttack = new OLAttackAPI();
  game.modules.get(MODULE_ID).api = game.olAttack;
});

Hooks.once("ready", () => {
  registerSocket();
  registerDamageLedger();
  registerChatHandlers();
  registerSheetButtons();
  registrarRetratos();
  installHotbarMacros();
  migrarFlagsAntiguos();

  if (!game.user?.isGM) {
    const recibir = () => {
      try {
        game.olAttack?.receivePlayerSceneState?.(game.settings.get(MODULE_ID, "playerScenePublicState") || {});
      } catch (_) {}
    };
    recibir();
    Hooks.on("updateSetting", (setting) => {
      if (String(setting?.key || "") === `${MODULE_ID}.playerScenePublicState`) recibir();
    });
  }

  console.log(`[${MODULE_ID}] Ready. Socket: ${SOCKET_NS}`);
});
