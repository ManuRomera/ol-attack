import { MODULE_ID, SETTING_ACTION_PROFILE_REGISTRY, SETTING_PROFILE_WINDOW_STATE, SETTING_WINDOW_LAYOUT_STATE, SETTING_SCENE_TRACKER_WINDOW_STATE, SETTING_DAMAGE_LEDGER_STATE, SETTING_PLAYER_SCENE_PUBLIC_STATE, SETTING_PLAYER_SCENE_WINDOW_STATE, SETTING_SYSTEM_ADAPTER_CONFIG } from "./constants.js";
import { ActionProfileConfigApp } from "../ui/action-profile-config.js";
import { SystemAdapterConfigApp } from "../ui/system-adapter-config.js";
import { getDefaultSystemAdapterConfig } from "./system-data.js";

export function registerSettings() {
  // Estado de ventana por usuario (client)
  game.settings.register(MODULE_ID, "windowState", {
    name: "OL Attack Window State",
    hint: "Posición/tamaño/pestaña/último ítem por usuario.",
    scope: "client",
    config: false,
    type: Object,
    default: { left: null, top: null, width: null, height: null, tab: "main", itemId: null }
  });

  game.settings.register(MODULE_ID, SETTING_PROFILE_WINDOW_STATE, {
    name: "OL Attack Action Profile Window State",
    scope: "client",
    config: false,
    type: Object,
    default: { left: null, top: null, width: 1100, height: 760, selectedUid: null, search: "", overridesOnly: false, activeTab: "catalog" }
  });

  game.settings.register(MODULE_ID, SETTING_ACTION_PROFILE_REGISTRY, {
    name: "OL Attack Action Profile Registry",
    scope: "world",
    config: false,
    type: Object,
    default: { profiles: {} }
  });

  game.settings.register(MODULE_ID, SETTING_WINDOW_LAYOUT_STATE, {
    name: "OL Attack Window Layout State",
    hint: "Posición y tamaño de ventanas del módulo por usuario.",
    scope: "client",
    config: false,
    type: Object,
    default: { windows: {} }
  });

  game.settings.register(MODULE_ID, SETTING_SCENE_TRACKER_WINDOW_STATE, {
    name: "OL Attack Scene Tracker Window State",
    scope: "client",
    config: false,
    type: Object,
    default: {
      left: null,
      top: null,
      width: 980,
      height: 720,
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

  game.settings.register(MODULE_ID, SETTING_PLAYER_SCENE_WINDOW_STATE, {
    name: "OL Attack Player Scene Window State",
    scope: "client",
    config: false,
    type: Object,
    default: {
      left: null,
      top: null,
      width: 860,
      height: 520,
      combatOrientation: "horizontal"
    }
  });


  game.settings.registerMenu(MODULE_ID, "systemAdapterMenu", {
    name: "Modelo de datos / Homebrew",
    label: "Configurar modelo de datos",
    hint: "Ajusta rutas clave para HP, rasgos, magia y compatibilidad con Homebrew.",
    restricted: true,
    type: SystemAdapterConfigApp
  });

  game.settings.registerMenu(MODULE_ID, "actionProfileMenu", {
    name: "Perfiles de acción",
    label: "Configurar perfiles de acción",
    hint: "Configura el comportamiento de hechizos, rasgos e ítems sin depender del nombre visible.",
    restricted: true,
    type: ActionProfileConfigApp
  });
}
