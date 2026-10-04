import { MODULE_ID, SETTING_ACTION_PROFILE_REGISTRY, SETTING_SCENE_TRACKER_WINDOW_STATE, SETTING_DAMAGE_LEDGER_STATE, SETTING_PLAYER_SCENE_PUBLIC_STATE, SETTING_SYSTEM_ADAPTER_CONFIG, SETTING_FLAGS_MIGRATED } from "./constants.js";
import { ActionProfileConfigApp } from "../ui/action-profile-config.js";
import { SystemAdapterConfigApp } from "../ui/system-adapter-config.js";
import { getDefaultSystemAdapterConfig } from "./system-data.js";

/**
 * La posición y el tamaño de las ventanas ya no se guardan como ajustes (escribían en la base de
 * datos a cada arrastre): viven en localStorage, ver lib/memoria.js. Los ajustes que quedan aquí
 * son datos reales del módulo.
 */
export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_ACTION_PROFILE_REGISTRY, {
    name: "OL Attack Action Profile Registry",
    scope: "world",
    config: false,
    type: Object,
    default: { profiles: {} }
  });

  game.settings.register(MODULE_ID, SETTING_FLAGS_MIGRATED, {
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "installMacros", {
    name: "OLATTACK.Settings.InstallMacros",
    hint: "OLATTACK.Settings.InstallMacrosHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  // Selección y aspecto del monitor de escena (por usuario). La geometría no va aquí.
  game.settings.register(MODULE_ID, SETTING_SCENE_TRACKER_WINDOW_STATE, {
    name: "OL Attack Scene Tracker State",
    scope: "client",
    config: false,
    type: Object,
    default: {
      displayMode: "overview",
      visibleTokenIds: [],
      combatTokenIds: [],
      gmHandledTokenId: null
    }
  });

  game.settings.register(MODULE_ID, SETTING_DAMAGE_LEDGER_STATE, {
    name: "OL Attack Damage Ledger State",
    scope: "client",
    config: false,
    type: Object,
    default: {
      active: true,
      lines: [],
      deletedStack: [],
      processedKeys: []
    }
  });

  game.settings.register(MODULE_ID, SETTING_PLAYER_SCENE_PUBLIC_STATE, {
    name: "OL Attack Player Scene Public State",
    scope: "world",
    config: false,
    type: Object,
    default: {
      active: false,
      sceneId: null,
      sceneName: null,
      orderedTokenIds: [],
      combatTokenIds: [],
      gmHandledTokenId: null,
      combatMeta: {},
      playerViewConfig: {
        showPCs: true,
        showNPCs: true,
        showHP: true,
        showTempHP: true,
        showResources: false,
        showStatuses: true,
        showQuickTraits: true,
        showWeaknesses: false
      },
      timestamp: 0
    }
  });

  game.settings.register(MODULE_ID, SETTING_SYSTEM_ADAPTER_CONFIG, {
    name: "OL Attack System Adapter Config",
    scope: "world",
    config: false,
    type: Object,
    default: getDefaultSystemAdapterConfig()
  });

  game.settings.registerMenu(MODULE_ID, "systemAdapterMenu", {
    name: "OLATTACK.Settings.AdapterName",
    label: "OLATTACK.Settings.AdapterLabel",
    hint: "OLATTACK.Settings.AdapterHint",
    icon: "fa-solid fa-database",
    restricted: true,
    type: SystemAdapterConfigApp
  });

  game.settings.registerMenu(MODULE_ID, "actionProfileMenu", {
    name: "OLATTACK.Settings.ProfilesName",
    label: "OLATTACK.Settings.ProfilesLabel",
    hint: "OLATTACK.Settings.ProfilesHint",
    icon: "fa-solid fa-sliders",
    restricted: true,
    type: ActionProfileConfigApp
  });
}
