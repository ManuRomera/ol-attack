import { MODULE_ID, SETTING_SYSTEM_ADAPTER_CONFIG } from "../shared/constants.js";
import { LegacyFormApplication } from "../shared/compat.js";
import { getDefaultSystemAdapterConfig, normalizeSystemAdapterConfig } from "../shared/system-data.js";

export class SystemAdapterConfigApp extends LegacyFormApplication {
  constructor(options = {}) {
    super(options);
    this.state = normalizeSystemAdapterConfig(game.settings.get(MODULE_ID, SETTING_SYSTEM_ADAPTER_CONFIG) || {});
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "ol-system-adapter-config",
      title: "OL Attack · Modelo de datos / Homebrew",
      template: "modules/ol-attack/templates/system-adapter-config.hbs",
      width: 760,
      height: 760,
      minWidth: 640,
      minHeight: 520,
      resizable: true,
      classes: ["ol-attack", "ol-window-theme", "ol-system-adapter-config"]
    });
  }

  getData() {
    return {
      cfg: this.state,
      isCustom: String(this.state.profile) === 'custom'
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.on('click', '[data-action="reset-defaults"]', async (ev) => {
      ev.preventDefault();
      this.state = getDefaultSystemAdapterConfig();
      this.render(false);
    });
    html.on('change', 'select[name="profile"]', (ev) => {
      const profile = String(ev.currentTarget.value || 'dnd5e-2024');
      this.state.profile = profile;
      if (profile === 'dnd5e-2024') {
        const keepToggles = {
          allowAnySystemSheetButton: !!this.state.allowAnySystemSheetButton,
          allowAnySystemTokenHud: !!this.state.allowAnySystemTokenHud
        };
        this.state = { ...getDefaultSystemAdapterConfig(), ...keepToggles, profile };
      }
      this.render(false);
    });
  }

  async _updateObject(_event, formData) {
    const expanded = foundry.utils.expandObject(formData || {});
    const incoming = {
      profile: expanded.profile,
      allowAnySystemSheetButton: !!expanded.allowAnySystemSheetButton,
      allowAnySystemTokenHud: !!expanded.allowAnySystemTokenHud,
      hpValuePath: expanded.hpValuePath,
      hpMaxPath: expanded.hpMaxPath,
      hpTempPath: expanded.hpTempPath,
      hpTempMaxPath: expanded.hpTempMaxPath,
      deathSuccessPath: expanded.deathSuccessPath,
      deathFailurePath: expanded.deathFailurePath,
      traitsRootPath: expanded.traitsRootPath,
      spellSlotsRootPath: expanded.spellSlotsRootPath,
      profPath: expanded.profPath,
      spellDcPath: expanded.spellDcPath,
      spellcastingAbilityPath: expanded.spellcastingAbilityPath,
      abilitiesRootPath: expanded.abilitiesRootPath,
      classesPath: expanded.classesPath,
      levelPath: expanded.levelPath,
      crPath: expanded.crPath,
      acPath: expanded.acPath
    };
    this.state = normalizeSystemAdapterConfig({ ...this.state, ...incoming });
    await game.settings.set(MODULE_ID, SETTING_SYSTEM_ADAPTER_CONFIG, this.state);
    ui.notifications.info('Configuración de modelo de datos guardada.');
  }
}
