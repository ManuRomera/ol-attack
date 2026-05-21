import { ensureLegacyAppApi } from "./shared/compat.js";
import { MODULE_ID, SOCKET_NS } from "./shared/constants.js";
import { registerSettings } from "./shared/settings.js";
import { registerSocket } from "./socket/socket.js";
import { registerSheetButtons } from "./ui/sheet-buttons.js";
import { registerChatHandlers } from "./chat/chat-handlers.js";
import { registerDamageLedger } from "./lib/damage-ledger.js";
import { installHotbarMacros } from "./lib/hotbar-macros.js";
import { OLAttackAPI } from "./api.js";

Hooks.once("init", () => {
  ensureLegacyAppApi();
  registerSettings();
  // Exponer API
  game.olAttack = new OLAttackAPI();
  game.modules.get(MODULE_ID).api = game.olAttack;
});

Hooks.once("ready", () => {
  registerSocket();
  registerDamageLedger();
  registerChatHandlers();
  registerSheetButtons();
  installHotbarMacros();

  if (!game.user?.isGM) {
    try {
      const state = game.settings.get(MODULE_ID, "playerScenePublicState") || {};
      game.olAttack?.receivePlayerSceneState?.(state);
    } catch (_) {}

    Hooks.on("updateSetting", (setting) => {
      try {
        const key = String(setting?.key || setting?.documentName || "");
        if (key !== `${MODULE_ID}.playerScenePublicState`) return;
        const state = game.settings.get(MODULE_ID, "playerScenePublicState") || {};
        game.olAttack?.receivePlayerSceneState?.(state);
      } catch (_) {}
    });
  }

  console.log(`[${MODULE_ID}] Ready. Socket: ${SOCKET_NS}`);
});
