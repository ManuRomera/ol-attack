import { MODULE_ID, SETTING_SYSTEM_ADAPTER_CONFIG } from "../shared/constants.js";
import { OLApp } from "./base-app.js";
import { getDefaultSystemAdapterConfig, normalizeSystemAdapterConfig } from "../shared/system-data.js";

const CAMPOS_TEXTO = [
  "hpValuePath", "hpMaxPath", "hpTempPath", "hpTempMaxPath", "deathSuccessPath", "deathFailurePath",
  "traitsRootPath", "spellSlotsRootPath", "profPath", "spellDcPath", "spellcastingAbilityPath",
  "abilitiesRootPath", "classesPath", "levelPath", "crPath", "acPath"
];

export class SystemAdapterConfigApp extends OLApp {
  static MEMORIA = "system-adapter";

  static DEFAULT_OPTIONS = {
    id: "ol-system-adapter-config",
    classes: ["ol-attack", "ol-window", "ol-system-adapter-config"],
    position: { width: 720, height: 700 },
    window: { title: "OLATTACK.Settings.AdapterTitle", icon: "fa-solid fa-database", resizable: true }
  };

  static PARTS = {
    main: { template: "modules/ol-attack/templates/system-adapter-config.hbs", scrollable: [".ol-syscfg"] }
  };

  constructor(options = {}) {
    super(options);
    this._estado = normalizeSystemAdapterConfig(game.settings.get(MODULE_ID, SETTING_SYSTEM_ADAPTER_CONFIG) || {});
  }

  getData() {
    return {
      cfg: this._estado,
      isCustom: String(this._estado.profile) === "custom"
    };
  }

  /** Lo escrito en el formulario, sin guardar todavía (para no perderlo al repintar). */
  _leerFormulario(form) {
    const datos = {
      profile: form.elements.profile?.value,
      allowAnySystemSheetButton: !!form.elements.allowAnySystemSheetButton?.checked,
      allowAnySystemTokenHud: !!form.elements.allowAnySystemTokenHud?.checked
    };
    for (const k of CAMPOS_TEXTO) datos[k] = form.elements[k]?.value;
    return datos;
  }

  activateListeners(html) {
    const form = html.is("form") ? html[0] : html.find("form")[0];
    html.on("click", '[data-action="reset-defaults"]', (ev) => {
      ev.preventDefault();
      this._estado = getDefaultSystemAdapterConfig();
      this.render(false);
    });
    html.on("change", 'select[name="profile"]', (ev) => {
      const profile = String(ev.currentTarget.value || "dnd5e-2024");
      const actual = this._leerFormulario(form);
      this._estado = normalizeSystemAdapterConfig({ ...this._estado, ...actual, profile });
      if (profile === "dnd5e-2024") {
        const keepToggles = {
          allowAnySystemSheetButton: !!this._estado.allowAnySystemSheetButton,
          allowAnySystemTokenHud: !!this._estado.allowAnySystemTokenHud
        };
        this._estado = { ...getDefaultSystemAdapterConfig(), ...keepToggles, profile };
      }
      this.render(false);
    });
    html.on("submit", async (ev) => {
      ev.preventDefault();
      this._estado = normalizeSystemAdapterConfig({ ...this._estado, ...this._leerFormulario(form) });
      await game.settings.set(MODULE_ID, SETTING_SYSTEM_ADAPTER_CONFIG, this._estado);
      ui.notifications.info(game.i18n.localize("OLATTACK.Settings.AdapterSaved"));
    });
  }
}
