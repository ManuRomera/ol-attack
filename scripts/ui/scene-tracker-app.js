import { MODULE_ID, SETTING_SCENE_TRACKER_WINDOW_STATE, SETTING_PLAYER_SCENE_PUBLIC_STATE, SOCKET_NS } from "../shared/constants.js";
import { OLApp } from "./base-app.js";
import { olConfirm, olNumber } from "./dialogs.js";
import { jq, filePicker } from "../shared/compat.js";
import { safeNum } from "../lib/utils.js";
import { openStatusPicker } from "../lib/statuses.js";
import { openOlContextMenu, closeOlContextMenu } from "../lib/context-menu.js";
import { getActorHpData, updateActorHpData } from "../shared/system-data.js";
import {
  norm, clamp, defaultVisualSettings, defaultPlayerViewConfig, sortTokensByName, buildRow, buildCombatMeta,
  resolvePortraitChoice, collectAvailablePortraitOptions, imageModeLabel, isGenericPortrait
} from "../lib/scene-rows.js";
import {
  applyAllPendingDamageLedger,
  applyDamageLedgerLine,
  clearDamageLedgerAll,
  clearDamageLedgerApplied,
  deleteDamageLedgerLine,
  getDamageLedgerView,
  restoreDamageLedgerLine,
  toggleDamageLedgerActive,
  undoDamageLedgerDelete
} from "../lib/damage-ledger.js";

const t = (key, data) => game.i18n.format(key, data ?? {});
const ORIENTATIONS = ["horizontal", "vertical"];
const orientation = (v) => (ORIENTATIONS.includes(String(v)) ? String(v) : "horizontal");

/** Cambios de un token que alteran lo que muestran los monitores (mover el token no cuenta). */
const TOKEN_KEYS = ["hidden", "name", "texture", "delta", "actorId", "actorLink", "disposition"];
export function tokenChangeMatters(changes) {
  return TOKEN_KEYS.some((k) => foundry.utils.hasProperty(changes, k));
}
/** Un actor que solo cambia flags o metadatos no afecta a los monitores. */
export function actorChangeMatters(changes) {
  return Object.keys(foundry.utils.flattenObject(changes || {})).some((k) => !k.startsWith("flags.") && !k.startsWith("_stats"));
}

// ============================================================
// Configuración del monitor (visibilidad, combate, imágenes, vista de jugadores)
// ============================================================
class OLSceneTrackerConfigApp extends OLApp {
  static MEMORIA = "scene-tracker-config";

  static DEFAULT_OPTIONS = {
    id: "ol-scene-tracker-config-app",
    classes: ["ol-attack", "ol-window", "ol-scene-tracker", "ol-scene-config-app"],
    position: { width: 1060, height: 700 },
    window: { title: "OLATTACK.Scene.ConfigTitle", icon: "fa-solid fa-gear", resizable: true }
  };

  static PARTS = {
    main: { template: "modules/ol-attack/templates/scene-tracker-config-app.hbs", scrollable: [".ol-scene-config-list", ".ol-scene-config-scroll"] }
  };

  constructor(tracker, options = {}) {
    super(options);
    this.tracker = tracker;
    this.focusVisual = !!options.focusVisual;
    this._resolver = null;
    this._resolved = false;
    this.draft = this._buildDraft(options.selectedTokenId || "");
  }

  get title() {
    return t(this.focusVisual ? "OLATTACK.Scene.ConfigTitleVisual" : "OLATTACK.Scene.ConfigTitle");
  }

  _getTokens() {
    return this.tracker?._getSceneTokens?.() || [];
  }

  _buildDraft(selectedTokenId = "") {
    const tokens = this._getTokens();
    const visuals = this.tracker?._getVisualSettings?.() || defaultVisualSettings();
    const tokenIds = tokens.map((tk) => String(tk.id));
    const visibleIds = new Set((this.tracker?.visibleTokenIds?.length ? this.tracker.visibleTokenIds : tokenIds).map(String));
    const combatIds = new Set((this.tracker?.combatTokenIds || []).map(String));
    return {
      tokenIds,
      selectedTokenId: String(selectedTokenId || tokenIds[0] || ""),
      filterTerm: "",
      kindFilter: "all",
      visibleById: Object.fromEntries(tokenIds.map((id) => [id, visibleIds.has(id)])),
      combatById: Object.fromEntries(tokenIds.map((id) => [id, combatIds.has(id)])),
      opacityById: Object.fromEntries(tokenIds.map((id) => [id, this.tracker?._getPerTokenOpacity?.(id, visuals) ?? Number(visuals.backgroundOpacity || 40)])),
      imageChoiceById: Object.fromEntries(tokenIds.map((id) => [id, this.tracker?._getPerTokenImageChoice?.(id) || { mode: "auto", custom: "" }])),
      visualSettings: foundry.utils.mergeObject(defaultVisualSettings(), foundry.utils.deepClone(visuals || {})),
      combatOrientation: orientation(this.tracker?.combatOrientation),
      playerViewConfig: foundry.utils.mergeObject(defaultPlayerViewConfig(), foundry.utils.deepClone(this.tracker?.playerViewConfig || {}))
    };
  }

  _getTokenById(id) {
    const sid = String(id || "");
    return this._getTokens().find((tk) => String(tk.id) === sid) || null;
  }

  _ensureSelectedToken() {
    const tokens = this._getTokens();
    const ids = new Set(tokens.map((tk) => String(tk.id)));
    if (ids.has(String(this.draft.selectedTokenId || ""))) return;
    this.draft.selectedTokenId = String(tokens[0]?.id || "");
  }

  _subLine(actor, token) {
    return [
      actor?.hasPlayerOwner ? t("OLATTACK.Scene.PC") : t("OLATTACK.Scene.NPC"),
      token?.document?.hidden ? t("OLATTACK.Scene.Hidden") : null,
      t(isGenericPortrait(actor?.img) ? "OLATTACK.Scene.Img.autoToken" : "OLATTACK.Scene.Img.autoActor")
    ].filter(Boolean).join(" · ");
  }

  _rowData(token) {
    const actor = token?.actor;
    const id = String(token?.id || "");
    const choice = this.draft.imageChoiceById[id] || { mode: "auto", custom: "" };
    const portraits = resolvePortraitChoice(actor, token, choice);
    const type = actor?.hasPlayerOwner ? t("OLATTACK.Scene.PC") : t("OLATTACK.Scene.NPC");
    return {
      id,
      name: token?.name || actor?.name || "—",
      sub: this._subLine(actor, token),
      avatar: portraits.avatar || portraits.portrait || "icons/svg/mystery-man.svg",
      kind: actor?.hasPlayerOwner ? "pc" : "npc",
      search: norm(`${token?.name || actor?.name || ""} ${type} ${token?.document?.hidden ? t("OLATTACK.Scene.Hidden") : ""}`),
      isSelected: String(this.draft.selectedTokenId || "") === id,
      visible: !!this.draft.visibleById[id],
      combat: !!this.draft.combatById[id]
    };
  }

  _selectedData() {
    const token = this._getTokenById(this.draft.selectedTokenId);
    if (!token?.actor) return null;
    const actor = token.actor;
    const id = String(token.id);
    const choice = this.draft.imageChoiceById[id] || { mode: "auto", custom: "" };
    const opacity = clamp(safeNum(this.draft.opacityById[id], Number(this.draft.visualSettings?.backgroundOpacity) || 40), 0, 100);
    const resolved = resolvePortraitChoice(actor, token, choice);
    const mode = String(choice.mode || "auto");
    const available = collectAvailablePortraitOptions(actor, token);
    const modeOptions = [
      { value: "auto", label: t("OLATTACK.Scene.Img.auto"), selected: mode === "auto" },
      ...available.map((opt) => ({ value: opt.key, label: opt.label, selected: mode === String(opt.key) })),
      { value: "custom", label: t("OLATTACK.Scene.Img.custom"), selected: mode === "custom" }
    ];
    const quickButtons = [
      { value: "auto", label: t("OLATTACK.Scene.Img.auto"), selected: mode === "auto" },
      ...available.map((opt) => ({ value: opt.key, label: t(`OLATTACK.Scene.Img.${opt.key}Short`), selected: mode === String(opt.key) })),
      { value: "custom", label: t("OLATTACK.Scene.Img.customShort"), selected: mode === "custom" }
    ];
    return {
      id,
      name: token.name || actor.name || "—",
      sub: this._subLine(actor, token),
      preview: resolved.portrait || resolved.avatar || "icons/svg/mystery-man.svg",
      resolvedLabel: imageModeLabel(mode, actor),
      opacity,
      custom: String(choice.custom || ""),
      modeOptions,
      quickButtons
    };
  }

  getData() {
    this._ensureSelectedToken();
    const rows = this._getTokens().map((token) => this._rowData(token));
    const visuals = this.draft.visualSettings || defaultVisualSettings();
    const playerView = this.draft.playerViewConfig || defaultPlayerViewConfig();
    return {
      rows,
      selected: this._selectedData(),
      filterTerm: String(this.draft.filterTerm || ""),
      kindAllSelected: String(this.draft.kindFilter || "all") === "all",
      kindPCSelected: String(this.draft.kindFilter || "all") === "pc",
      kindNPCSelected: String(this.draft.kindFilter || "all") === "npc",
      usePortraitBackground: !!visuals.usePortraitBackground,
      backgroundOpacity: Number(visuals.backgroundOpacity) || 40,
      overlayOpacity: Number(visuals.overlayOpacity) || 60,
      backgroundSizeCover: String(visuals.backgroundSize || "cover") === "cover",
      backgroundSizeContain: String(visuals.backgroundSize || "cover") === "contain",
      combatOrientationHorizontal: String(this.draft.combatOrientation || "horizontal") === "horizontal",
      combatOrientationVertical: String(this.draft.combatOrientation || "horizontal") === "vertical",
      playerShowPCs: !!playerView.showPCs,
      playerShowNPCs: !!playerView.showNPCs,
      playerShowHP: !!playerView.showHP,
      playerShowTempHP: !!playerView.showTempHP,
      playerShowResources: !!playerView.showResources,
      playerShowStatuses: !!playerView.showStatuses,
      playerShowQuickTraits: !!playerView.showQuickTraits,
      playerShowWeaknesses: !!playerView.showWeaknesses
    };
  }

  _applyFilterVisibility(html) {
    const term = norm(this.draft.filterTerm || "");
    const kind = String(this.draft.kindFilter || "all");
    html.find(".ol-scene-config-row").each((_, el) => {
      const row = jq(el);
      const okKind = kind === "all" || String(row.data("kind") || "") === kind;
      const okText = !term || String(row.data("search") || "").includes(term);
      row.toggle(okKind && okText);
    });
  }

  _selectedInputTid() {
    return String(this.draft.selectedTokenId || "");
  }

  _setSelectedToken(id) {
    this.draft.selectedTokenId = String(id || "");
    this.render(false);
  }

  _updateGeneralDraftFromDom(html) {
    this.draft.visualSettings = foundry.utils.mergeObject(defaultVisualSettings(), {
      usePortraitBackground: !!html.find('input[name="usePortraitBackground"]').prop("checked"),
      backgroundOpacity: clamp(safeNum(html.find('input[name="backgroundOpacity"]').val(), 40), 0, 100),
      overlayOpacity: clamp(safeNum(html.find('input[name="overlayOpacity"]').val(), 60), 20, 90),
      backgroundSize: String(html.find('select[name="backgroundSize"]').val() || "cover")
    });
    this.draft.combatOrientation = orientation(html.find('select[name="combatOrientation"]').val());
    this.draft.playerViewConfig = foundry.utils.mergeObject(defaultPlayerViewConfig(), {
      showPCs: !!html.find('input[name="playerShowPCs"]').prop("checked"),
      showNPCs: !!html.find('input[name="playerShowNPCs"]').prop("checked"),
      showHP: !!html.find('input[name="playerShowHP"]').prop("checked"),
      showTempHP: !!html.find('input[name="playerShowTempHP"]').prop("checked"),
      showResources: !!html.find('input[name="playerShowResources"]').prop("checked"),
      showStatuses: !!html.find('input[name="playerShowStatuses"]').prop("checked"),
      showQuickTraits: !!html.find('input[name="playerShowQuickTraits"]').prop("checked"),
      showWeaknesses: !!html.find('input[name="playerShowWeaknesses"]').prop("checked")
    });
  }

  activateListeners(html) {
    this._applyFilterVisibility(html);

    html.on("input", '[data-role="tokenFilter"]', (ev) => {
      this.draft.filterTerm = String(ev.currentTarget.value || "");
      this._applyFilterVisibility(html);
    });

    html.on("click", '[data-role="kindFilter"]', (ev) => {
      ev.preventDefault();
      this.draft.kindFilter = String(ev.currentTarget.dataset.kind || "all");
      html.find('[data-role="kindFilter"]').removeClass("selected");
      jq(ev.currentTarget).addClass("selected");
      this._applyFilterVisibility(html);
    });

    html.on("click", '[data-role="selectToken"]', (ev) => {
      ev.preventDefault();
      const tid = String(jq(ev.currentTarget).closest(".ol-scene-config-row").data("tokenId") || ev.currentTarget.dataset.tokenId || "");
      if (!tid) return;
      this._updateGeneralDraftFromDom(html);
      this._setSelectedToken(tid);
    });

    html.on("change", 'input[data-role="visible"]', (ev) => {
      const tid = String(ev.currentTarget.dataset.tokenId || "");
      this.draft.visibleById[tid] = !!ev.currentTarget.checked;
      if (!ev.currentTarget.checked) {
        this.draft.combatById[tid] = false;
        html.find(`input[data-role="combat"][data-token-id="${tid}"]`).prop("checked", false);
      }
    });

    html.on("change", 'input[data-role="combat"]', (ev) => {
      const tid = String(ev.currentTarget.dataset.tokenId || "");
      this.draft.combatById[tid] = !!ev.currentTarget.checked;
      if (ev.currentTarget.checked) {
        this.draft.visibleById[tid] = true;
        html.find(`input[data-role="visible"][data-token-id="${tid}"]`).prop("checked", true);
      }
    });

    const bulkOnFiltered = (updater) => {
      html.find(".ol-scene-config-row:visible").each((_, el) => updater(jq(el)));
    };
    const setRow = (row, { visible, combat }) => {
      const tid = String(row.data("tokenId") || "");
      if (visible !== undefined) { this.draft.visibleById[tid] = visible; row.find('input[data-role="visible"]').prop("checked", visible); }
      if (combat !== undefined) { this.draft.combatById[tid] = combat; row.find('input[data-role="combat"]').prop("checked", combat); }
    };
    html.on("click", '[data-role="bulkVisibleFiltered"]', (ev) => { ev.preventDefault(); bulkOnFiltered((row) => setRow(row, { visible: true })); });
    html.on("click", '[data-role="bulkCombatFiltered"]', (ev) => { ev.preventDefault(); bulkOnFiltered((row) => setRow(row, { visible: true, combat: true })); });
    html.on("click", '[data-role="bulkClearFiltered"]', (ev) => { ev.preventDefault(); bulkOnFiltered((row) => setRow(row, { visible: false, combat: false })); });

    const setChoice = (patch) => {
      const tid = this._selectedInputTid();
      this.draft.imageChoiceById[tid] = { ...(this.draft.imageChoiceById[tid] || {}), ...patch };
    };

    html.on("change", '[data-role="inspectorImageMode"]', (ev) => {
      setChoice({ mode: String(ev.currentTarget.value || "auto") });
      this._updateGeneralDraftFromDom(html);
      this.render(false);
    });

    html.on("click", '[data-role="inspectorQuick"]', (ev) => {
      ev.preventDefault();
      setChoice({ mode: String(ev.currentTarget.dataset.mode || "auto") });
      this._updateGeneralDraftFromDom(html);
      this.render(false);
    });

    html.on("input change", '[data-role="inspectorImageCustom"]', (ev) => {
      const value = String(ev.currentTarget.value || "");
      const tid = this._selectedInputTid();
      setChoice({ mode: value.trim() ? "custom" : String(this.draft.imageChoiceById[tid]?.mode || "auto"), custom: value });
    });

    html.on("input change", '[data-role="inspectorOpacity"]', (ev) => {
      const value = clamp(safeNum(ev.currentTarget.value, 40), 0, 100);
      this.draft.opacityById[this._selectedInputTid()] = value;
      html.find('[data-role="inspectorOpacityValue"]').text(`${value}%`);
    });

    html.on("click", '[data-role="inspectorImageBrowse"]', (ev) => {
      ev.preventDefault();
      const tid = this._selectedInputTid();
      if (!tid) return;
      const current = String(this.draft.imageChoiceById[tid]?.custom || "").trim();
      const FP = filePicker();
      new FP({
        type: "imagevideo",
        current: current || "data",
        callback: (path) => {
          setChoice({ mode: "custom", custom: path || "" });
          this._updateGeneralDraftFromDom(html);
          this.render(false);
        }
      }).render({ force: true });
    });

    html.on("input change", 'input[name="backgroundOpacity"]', (ev) => html.find('[data-role="backgroundOpacityValue"]').text(`${ev.currentTarget.value}%`));
    html.on("input change", 'input[name="overlayOpacity"]', (ev) => html.find('[data-role="overlayOpacityValue"]').text(`${ev.currentTarget.value}%`));

    html.on("click", '[data-action="reset-defaults"]', (ev) => {
      ev.preventDefault();
      this.draft = this._buildDraft(this._selectedInputTid());
      this.render(false);
    });
    html.on("click", '[data-action="show-all"]', (ev) => {
      ev.preventDefault();
      Object.keys(this.draft.visibleById || {}).forEach((id) => { this.draft.visibleById[id] = true; });
      Object.keys(this.draft.combatById || {}).forEach((id) => { this.draft.combatById[id] = false; });
      this.render(false);
    });
    html.on("click", '[data-action="cancel"]', (ev) => { ev.preventDefault(); this.close(); });
    html.on("click", '[data-action="save"]', async (ev) => { ev.preventDefault(); await this._saveAndClose(html); });
  }

  async _saveAndClose(html) {
    this._updateGeneralDraftFromDom(html);
    const tokenIds = this._getTokens().map((tk) => String(tk.id));
    const visible = tokenIds.filter((id) => !!this.draft.visibleById[id]);
    const combat = tokenIds.filter((id) => !!this.draft.combatById[id]);
    const tr = this.tracker;
    tr.visibleTokenIds = visible.length === tokenIds.length ? [] : visible;
    tr.combatTokenIds = combat;
    tr.visualSettings = foundry.utils.mergeObject(defaultVisualSettings(), foundry.utils.deepClone(this.draft.visualSettings || {}));
    tr.visualTokenOpacity = foundry.utils.deepClone(this.draft.opacityById || {});
    tr.visualTokenImageChoice = foundry.utils.deepClone(this.draft.imageChoiceById || {});
    tr.combatOrientation = orientation(this.draft.combatOrientation);
    tr.playerViewConfig = foundry.utils.mergeObject(defaultPlayerViewConfig(), foundry.utils.deepClone(this.draft.playerViewConfig || {}));
    await tr._persistState?.();
    tr.render();
    this._resolved = true;
    this._resolver?.({
      visible: tr.visibleTokenIds, combat: tr.combatTokenIds, visualSettings: tr.visualSettings,
      visualTokenOpacity: tr.visualTokenOpacity, visualTokenImageChoice: tr.visualTokenImageChoice,
      combatOrientation: tr.combatOrientation, playerViewConfig: tr.playerViewConfig
    });
    return this.close();
  }

  waitForClose() {
    return new Promise((resolve) => { this._resolver = resolve; });
  }

  async close(options = {}) {
    if (!this._resolved && this._resolver) {
      this._resolver(null);
      this._resolver = null;
    }
    return super.close(options);
  }
}

// ============================================================
// Monitor de escena (GM)
// ============================================================
export class OLSceneTrackerApp extends OLApp {
  static MEMORIA = "scene-tracker";
  static DRAG_ANYWHERE = true;

  static DEFAULT_OPTIONS = {
    id: "ol-scene-tracker-app",
    classes: ["ol-attack", "ol-window", "ol-scene-tracker"],
    position: { width: 940, height: 640 },
    window: { title: "OLATTACK.Scene.Title", icon: "fa-solid fa-table-columns", resizable: true, minimizable: true }
  };

  static PARTS = {
    main: { template: "modules/ol-attack/templates/scene-tracker-app.hbs", scrollable: [".ol-scene-grid", ".ol-ledger-list"] }
  };

  constructor(options = {}) {
    super(options);
    this._hookIds = [];
    this._estado = this._loadState();
    this.displayMode = String(options.displayMode || this._estado.displayMode || "overview");
    const ids = (v, fallback) => (Array.isArray(v) ? v.map(String) : Array.isArray(fallback) ? fallback.map(String) : []);
    this.visibleTokenIds = ids(options.visibleTokenIds, this._estado.visibleTokenIds);
    this.combatTokenIds = ids(options.combatTokenIds, this._estado.combatTokenIds);
    this.visualSettings = foundry.utils.mergeObject(defaultVisualSettings(), foundry.utils.deepClone(options.visualSettings || this._estado.visualSettings || {}));
    this.visualTokenOpacity = foundry.utils.deepClone(options.visualTokenOpacity || this._estado.visualTokenOpacity || {});
    this.visualTokenImageChoice = foundry.utils.deepClone(options.visualTokenImageChoice || this._estado.visualTokenImageChoice || {});
    this.combatOrientation = orientation(options.combatOrientation || this._estado.combatOrientation);
    this.playerViewConfig = foundry.utils.mergeObject(defaultPlayerViewConfig(), foundry.utils.deepClone(options.playerViewConfig || this._estado.playerViewConfig || {}));
    this.gmHandledTokenId = String(options.gmHandledTokenId || this._estado.gmHandledTokenId || game.olAttack?.getHandledToken?.()?.id || "");
    if (this.gmHandledTokenId) game.olAttack?.setHandledToken?.(this.gmHandledTokenId);
  }

  _loadState() {
    try {
      return foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTING_SCENE_TRACKER_WINDOW_STATE) || {});
    } catch (_) {
      return {};
    }
  }

  /** Selección y aspecto del monitor (ajuste de cliente: no escribe en la base de datos del mundo). */
  _persistState() {
    const state = {
      displayMode: this.displayMode || "overview",
      visibleTokenIds: Array.from(this.visibleTokenIds || []).map(String),
      combatTokenIds: Array.from(this.combatTokenIds || []).map(String),
      visualSettings: foundry.utils.mergeObject(defaultVisualSettings(), foundry.utils.deepClone(this.visualSettings || {})),
      visualTokenOpacity: foundry.utils.deepClone(this.visualTokenOpacity || {}),
      visualTokenImageChoice: foundry.utils.deepClone(this.visualTokenImageChoice || {}),
      combatOrientation: orientation(this.combatOrientation),
      playerViewConfig: foundry.utils.mergeObject(defaultPlayerViewConfig(), foundry.utils.deepClone(this.playerViewConfig || {})),
      gmHandledTokenId: this.gmHandledTokenId || null
    };
    this._estado = state;
    try { return game.settings.set(MODULE_ID, SETTING_SCENE_TRACKER_WINDOW_STATE, state); } catch (_) { return null; }
  }

  _getVisualSettings() {
    return foundry.utils.mergeObject(defaultVisualSettings(), foundry.utils.deepClone(this.visualSettings || {}));
  }

  _getPerTokenOpacity(tokenId, visuals = this._getVisualSettings()) {
    const raw = this.visualTokenOpacity?.[String(tokenId || "")];
    if (raw === "" || raw == null || Number.isNaN(Number(raw))) return Number(visuals.backgroundOpacity) || 40;
    return clamp(Number(raw), 0, 100);
  }

  _getPerTokenImageChoice(tokenId) {
    const raw = foundry.utils.deepClone(this.visualTokenImageChoice?.[String(tokenId || "")] || {});
    return { mode: String(raw.mode || "auto"), custom: String(raw.custom || "").trim() };
  }

  _getSceneTokens() {
    return sortTokensByName(Array.from(canvas?.tokens?.placeables || []).filter((tk) => tk?.actor));
  }

  _getTokenById(id) {
    const sid = String(id || "");
    return canvas?.tokens?.get?.(sid) || canvas?.tokens?.placeables?.find?.((tk) => String(tk.id) === sid) || null;
  }

  _getSceneCombat() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return null;
    return game.combats?.find?.((c) => String(c.scene?.id || c.scene) === String(sceneId)) || null;
  }

  _getEffectiveVisibleIds(tokens = this._getSceneTokens()) {
    const tokenIds = tokens.map((tk) => String(tk.id));
    if (!this.visibleTokenIds.length) return tokenIds;
    return tokenIds.filter((id) => this.visibleTokenIds.includes(id));
  }

  _getEffectiveCombatIds(tokens = this._getSceneTokens()) {
    const tokenIds = tokens.map((tk) => String(tk.id));
    if (this.combatTokenIds.length) return tokenIds.filter((id) => this.combatTokenIds.includes(id));
    return this._getEffectiveVisibleIds(tokens);
  }

  _row(token, extra) {
    const visuals = this._getVisualSettings();
    return buildRow(token, {
      ...extra,
      opacity: this._getPerTokenOpacity(token.id, visuals),
      imageChoice: this._getPerTokenImageChoice(token.id)
    }, { visuals });
  }

  _getOverviewRows(tokens = this._getSceneTokens()) {
    const visibleIds = new Set(this._getEffectiveVisibleIds(tokens));
    const combatIds = new Set(this._getEffectiveCombatIds(tokens));
    const targetedTokenId = String(Array.from(game.user?.targets || [])[0]?.id || "");
    const rows = tokens
      .filter((token) => visibleIds.has(String(token.id)))
      .map((token) => this._row(token, {
        selectionVisible: true,
        selectionCombat: combatIds.has(String(token.id)),
        isGmHandled: this.gmHandledTokenId === String(token.id),
        targetedTokenId
      }));
    rows.sort((a, b) => Number(b.isPC) - Number(a.isPC) || a.tokenName.localeCompare(b.tokenName, game.i18n.lang));
    return rows;
  }

  _getCombatRows(tokens = this._getSceneTokens()) {
    const combat = this._getSceneCombat();
    const selectedIds = this._getEffectiveCombatIds(tokens);
    const visibleIds = new Set(this._getEffectiveVisibleIds(tokens));
    const tokenMap = new Map(tokens.map((tk) => [String(tk.id), tk]));
    const combatantByTokenId = new Map(Array.from(combat?.combatants || []).map((c) => [String(c.tokenId), c]));
    const turnOrder = new Map(Array.from(combat?.turns || []).map((c, idx) => [String(c.tokenId), idx]));
    const activeTokenId = String(combat?.combatant?.tokenId || "");
    const targetedTokenId = String(Array.from(game.user?.targets || [])[0]?.id || "");

    const rows = selectedIds
      .map((tokenId) => {
        const token = tokenMap.get(String(tokenId));
        if (!token?.actor) return null;
        const combatant = combatantByTokenId.get(String(tokenId));
        return this._row(token, {
          initiative: combatant?.initiative,
          turnIndex: turnOrder.has(String(tokenId)) ? turnOrder.get(String(tokenId)) + 1 : null,
          isActiveTurn: activeTokenId === String(tokenId),
          inCombat: !!combatant,
          selectionVisible: visibleIds.has(String(tokenId)),
          selectionCombat: true,
          isGmHandled: this.gmHandledTokenId === String(tokenId),
          targetedTokenId
        });
      })
      .filter(Boolean);

    rows.sort((a, b) => {
      const ai = turnOrder.has(a.tokenId) ? turnOrder.get(a.tokenId) : Number.MAX_SAFE_INTEGER;
      const bi = turnOrder.has(b.tokenId) ? turnOrder.get(b.tokenId) : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      if (a.hasInitiative !== b.hasInitiative) return Number(b.hasInitiative) - Number(a.hasInitiative);
      if (a.hasInitiative && b.hasInitiative && a.initiative !== b.initiative) return (b.initiative || 0) - (a.initiative || 0);
      return a.tokenName.localeCompare(b.tokenName, game.i18n.lang);
    });

    // El turno activo aparece primero.
    const activeIndex = rows.findIndex((row) => row.isActiveTurn);
    return activeIndex > 0 ? rows.slice(activeIndex).concat(rows.slice(0, activeIndex)) : rows;
  }

  _buildCombatMeta(rows = []) {
    const combat = this._getSceneCombat();
    return buildCombatMeta(rows, {
      hasCombat: !!combat,
      combatRound: safeNum(combat?.round, 0),
      combatStarted: !!combat && safeNum(combat?.round, 0) > 0,
      activeName: combat?.combatant?.token?.name || combat?.combatant?.actor?.name || null
    });
  }

  // ---------- Publicación a jugadores ----------
  _buildPlayerPublicState() {
    const tokens = this._getSceneTokens();
    const combatRows = this._getCombatRows(tokens);
    return {
      active: this.displayMode === "combat",
      displayMode: this.displayMode,
      sceneId: canvas?.scene?.id || null,
      sceneName: canvas?.scene?.name || t("OLATTACK.Scene.CurrentScene"),
      orderedTokenIds: combatRows.map((r) => String(r.tokenId)),
      combatTokenIds: this._getEffectiveCombatIds(tokens).map(String),
      gmHandledTokenId: String(this.gmHandledTokenId || ""),
      combatMeta: this._buildCombatMeta(combatRows),
      playerViewConfig: foundry.utils.mergeObject(defaultPlayerViewConfig(), foundry.utils.deepClone(this.playerViewConfig || {})),
      visualSettings: this._getVisualSettings(),
      visualTokenOpacity: foundry.utils.deepClone(this.visualTokenOpacity || {}),
      visualTokenImageChoice: foundry.utils.deepClone(this.visualTokenImageChoice || {})
    };
  }

  /**
   * Publica el estado para los jugadores (ajuste de mundo + socket). Solo escribe si el contenido
   * cambió: antes se escribía en la base de datos del mundo en cada repintado, es decir, con cada
   * movimiento de token o cambio de PG.
   */
  async _publishPlayerSceneState(forceClose = false) {
    if (!game.user?.isGM) return;
    const base = this._buildPlayerPublicState();
    const state = forceClose ? { ...base, active: false, displayMode: "overview" } : base;
    const key = JSON.stringify(state);
    if (key === this._lastPublished) return;
    this._lastPublished = key;
    state.timestamp = Date.now();
    try { await game.settings.set(MODULE_ID, SETTING_PLAYER_SCENE_PUBLIC_STATE, state); } catch (_) {}
    try { game.socket?.emit?.(SOCKET_NS, { type: forceClose || !state.active ? "playerSceneClose" : "playerSceneState", state }); } catch (_) {}
  }

  _schedulePublish() {
    clearTimeout(this._publishTimer);
    this._publishTimer = setTimeout(() => this._publishPlayerSceneState(false), 300);
  }

  // ---------- Contexto ----------
  async getData() {
    const tokens = this._getSceneTokens();
    const visibleIds = this._getEffectiveVisibleIds(tokens);
    const combatIds = this._getEffectiveCombatIds(tokens);
    const isCombatMode = this.displayMode === "combat";
    const rows = isCombatMode ? this._getCombatRows(tokens) : this._getOverviewRows(tokens);
    const gmHandled = this._getTokenById(this.gmHandledTokenId);

    return {
      sceneName: canvas?.scene?.name || t("OLATTACK.Scene.CurrentScene"),
      hasScene: !!canvas?.scene,
      isCombatMode,
      rows,
      visibleCount: visibleIds.length,
      totalSceneCount: tokens.length,
      visibleSummary: this.visibleTokenIds.length ? t("OLATTACK.Scene.NSelected", { n: visibleIds.length }) : t("OLATTACK.Scene.All"),
      combatSummary: this.combatTokenIds.length ? t("OLATTACK.Scene.NSelected", { n: combatIds.length }) : t("OLATTACK.Scene.UsesVisible"),
      gmHandledName: gmHandled?.name || gmHandled?.actor?.name || null,
      modeButtons: [
        { value: "overview", label: t("OLATTACK.Scene.General"), title: t("OLATTACK.Scene.GeneralHint"), active: !isCombatMode },
        { value: "combat", label: t("OLATTACK.Scene.Combat"), title: t("OLATTACK.Scene.CombatHint"), active: isCombatMode }
      ],
      combatMeta: this._buildCombatMeta(isCombatMode ? rows : []),
      damageLedger: getDamageLedgerView(),
      combatOrientation: this.combatOrientation,
      isCombatVertical: this.combatOrientation === "vertical",
      open: { ledger: this.abierto("ledger", false) }
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._registerHooks();
    this._schedulePublish();
  }

  _queueRefresh() {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => { if (this.rendered) this.render(); }, 120);
  }

  // ---------- Interacciones ----------
  activateListeners(html) {
    html.on("click", '[data-action="refresh"]', (ev) => { ev.preventDefault(); this.render(); });

    html.on("click", '[data-action="set-mode"]', (ev) => {
      ev.preventDefault();
      this.displayMode = String(ev.currentTarget.dataset.mode || "overview");
      this._persistState();
      this.render();
    });

    html.on("click", '[data-action="open-config"]', (ev) => { ev.preventDefault(); this._openSelectionConfig(); });

    html.on("click", '[data-action="configure-combat"]', async (ev) => {
      ev.preventDefault();
      await this._openSelectionConfig();
      this.displayMode = "combat";
      this._persistState();
      this.render();
    });

    html.on("click", '[data-action="start-combat"]', async (ev) => { ev.preventDefault(); await this._startCombat(); });
    html.on("click", '[data-action="end-combat"]', async (ev) => { ev.preventDefault(); await this._endCombat(); });

    const turn = (dir) => async (ev) => {
      ev.preventDefault();
      const combat = this._getSceneCombat();
      if (!combat) return ui.notifications?.warn?.(t("OLATTACK.Scene.NoCombat"));
      await (dir > 0 ? combat.nextTurn() : combat.previousTurn());
    };
    html.on("click", '[data-action="next-turn"]', turn(1));
    html.on("click", '[data-action="prev-turn"]', turn(-1));

    html.on("click", '[data-action="roll-init-all"]', async (ev) => { ev.preventDefault(); await this._rollInitiativeForSelection("all"); });
    html.on("click", '[data-action="roll-init-npc"]', async (ev) => { ev.preventDefault(); await this._rollInitiativeForSelection("npc"); });
    html.on("click", '[data-action="roll-init-one"]', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const tokenId = String(ev.currentTarget.dataset.tokenId || "");
      if (tokenId) await this._rollInitiativeForSelection("one", tokenId);
    });

    // Libro de daño. Cada acción repinta por sí misma al cambiar el ajuste de cliente.
    const ledger = (action, fn) => html.on("click", `[data-action="${action}"]`, async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try { await fn(ev); } catch (err) { ui.notifications?.warn?.(err?.message || String(err)); }
      this.render();
    });
    ledger("toggle-damage-ledger", () => toggleDamageLedgerActive());
    ledger("apply-damage-ledger-all", () => applyAllPendingDamageLedger());
    ledger("apply-damage-ledger-line", (ev) => { const id = String(ev.currentTarget.dataset.lineId || ""); return id && applyDamageLedgerLine(id); });
    ledger("delete-damage-ledger-line", (ev) => { const id = String(ev.currentTarget.dataset.lineId || ""); return id && deleteDamageLedgerLine(id); });
    ledger("restore-damage-ledger-line", (ev) => { const id = String(ev.currentTarget.dataset.lineId || ""); return id && restoreDamageLedgerLine(id); });
    ledger("clear-damage-ledger-applied", () => clearDamageLedgerApplied());
    ledger("undo-damage-ledger-delete", async () => { if (!(await undoDamageLedgerDelete())) ui.notifications?.warn?.(t("OLATTACK.Ledger.NothingToUndo")); });
    ledger("clear-damage-ledger-all", async () => {
      const ok = await olConfirm({ title: "OLATTACK.Ledger.Clear", content: t("OLATTACK.Ledger.ConfirmClear"), danger: true });
      if (ok) await clearDamageLedgerAll();
    });

    html.on("click", ".ol-scene-card[data-token-id]", async (ev) => {
      if (jq(ev.target).closest("[data-action], [data-hp-token-id]").length) return;
      const token = this._getTokenById(String(ev.currentTarget.dataset.tokenId || ""));
      if (!token) return;
      try {
        await canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
        token.control({ releaseOthers: true });
      } catch {}
    });

    html.on("dblclick", ".ol-scene-card[data-token-id]", async (ev) => {
      if (jq(ev.target).closest("[data-action], [data-hp-token-id]").length) return;
      ev.preventDefault();
      ev.stopPropagation();
      const token = this._getTokenById(String(ev.currentTarget.dataset.tokenId || ""));
      if (token?.actor) game.olAttack?.open?.({ actor: token.actor, token });
    });

    html.on("contextmenu", ".ol-scene-card[data-token-id]", async (ev) => {
      if (jq(ev.target).closest("[data-action], [data-hp-token-id], button, input, select, textarea, a, label").length) return;
      ev.preventDefault();
      ev.stopPropagation();
      await this._openTokenContextMenu(String(ev.currentTarget.dataset.tokenId || ""), { x: ev.clientX, y: ev.clientY });
    });

    html.on("dblclick", "[data-hp-token-id]", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await this._promptSetHp(String(ev.currentTarget.dataset.hpTokenId || ""));
    });
  }

  async _openSelectionConfig(options = {}) {
    const tokens = this._getSceneTokens();
    if (!tokens.length) return ui.notifications?.warn?.(t("OLATTACK.Scene.NoTokensWithActor"));
    if (this._sceneConfigApp?.rendered) {
      if (options?.selectedTokenId) this._sceneConfigApp.draft.selectedTokenId = String(options.selectedTokenId);
      this._sceneConfigApp.focusVisual = !!options.focusVisual;
      this._sceneConfigApp.render({ force: true });
      return this._sceneConfigApp.waitForClose();
    }
    const app = new OLSceneTrackerConfigApp(this, options);
    this._sceneConfigApp = app;
    const waiter = app.waitForClose();
    app.render(true);
    waiter.finally(() => { if (this._sceneConfigApp === app) this._sceneConfigApp = null; });
    return waiter;
  }

  async _openTokenContextMenu(tokenId, point = {}) {
    const token = this._getTokenById(tokenId);
    if (!token?.actor) return;
    const isTargeted = Array.from(game.user?.targets || []).some((tk) => String(tk.id) === String(tokenId));
    const isHandled = this.gmHandledTokenId === String(tokenId);
    const name = token.name || token.actor.name;
    closeOlContextMenu();
    openOlContextMenu({
      x: safeNum(point.x, window.innerWidth / 2),
      y: safeNum(point.y, window.innerHeight / 2),
      title: name,
      items: [
        { label: t(isTargeted ? "OLATTACK.Ctx.Untarget" : "OLATTACK.Ctx.Target"), action: () => this._toggleTargetToken(tokenId, !isTargeted) },
        ...(game.user?.isGM ? [{ label: t(isHandled ? "OLATTACK.Ctx.StopHandling" : "OLATTACK.Ctx.Handle"), action: () => this._setHandledToken(isHandled ? null : tokenId) }] : []),
        { type: "separator" },
        { label: t("OLATTACK.Ctx.ApplyStatus"), action: () => openStatusPicker({ actor: token.actor, token, mode: "apply", title: t("OLATTACK.Status.ApplyTitle", { name }) }) },
        { label: t("OLATTACK.Ctx.RemoveStatus"), action: () => openStatusPicker({ actor: token.actor, token, mode: "remove", title: t("OLATTACK.Status.RemoveTitle", { name }) }) },
        { type: "separator" },
        { label: t("OLATTACK.Ctx.OpenAttack"), action: () => game.olAttack?.open?.({ actor: token.actor, token }) }
      ]
    });
  }

  async _toggleTargetToken(tokenId, state = true) {
    const token = this._getTokenById(tokenId);
    if (!token) return;
    try {
      token.setTarget(!!state, { user: game.user, releaseOthers: !!state, groupSelection: false });
    } catch {
      ui.notifications?.warn?.(t("OLATTACK.Scene.TargetFailed"));
    }
  }

  _setHandledToken(tokenId = null) {
    this.gmHandledTokenId = tokenId ? String(tokenId) : "";
    if (this.gmHandledTokenId) game.olAttack?.setHandledToken?.(this.gmHandledTokenId);
    else game.olAttack?.clearHandledToken?.();
    this._persistState();
    this.render();
  }

  // ---------- Combate ----------
  async _getOrCreateSceneCombat() {
    if (!canvas?.scene?.id) return null;
    let combat = this._getSceneCombat();
    if (combat) return combat;
    combat = await Combat.create({ scene: canvas.scene.id, active: true });
    return game.combats?.get?.(combat.id) || combat;
  }

  async _syncCombatParticipants() {
    const tokens = this._getSceneTokens();
    const selectedIds = this._getEffectiveCombatIds(tokens);
    if (!selectedIds.length) {
      ui.notifications?.warn?.(t("OLATTACK.Scene.NoParticipants"));
      return null;
    }

    const combat = await this._getOrCreateSceneCombat();
    if (!combat) return null;

    const tokenMap = new Map(tokens.map((tk) => [String(tk.id), tk]));
    const existingByToken = new Map(Array.from(combat.combatants || []).map((c) => [String(c.tokenId), c]));
    const toRemove = Array.from(combat.combatants || [])
      .filter((c) => !selectedIds.includes(String(c.tokenId)))
      .map((c) => c.id)
      .filter(Boolean);
    const toAdd = selectedIds
      .filter((tokenId) => !existingByToken.has(String(tokenId)))
      .map((tokenId) => {
        const token = tokenMap.get(String(tokenId));
        return { tokenId, actorId: token?.actor?.id, hidden: !!token?.document?.hidden };
      });

    if (toRemove.length) await combat.deleteEmbeddedDocuments("Combatant", toRemove);
    if (toAdd.length) await combat.createEmbeddedDocuments("Combatant", toAdd);
    return game.combats?.get?.(combat.id) || combat;
  }

  async _startCombat() {
    if (!this.combatTokenIds.length) {
      const configured = await this._openSelectionConfig();
      if (!configured) return;
    }
    if (!this.combatTokenIds.length) {
      ui.notifications?.warn?.(t("OLATTACK.Scene.PickBeforeStart"));
      return;
    }
    const combat = await this._syncCombatParticipants();
    if (!combat) return;
    if (safeNum(combat.round, 0) <= 0) await combat.startCombat();
    this.displayMode = "combat";
    this._persistState();
    this.render();
  }

  async _endCombat() {
    const combat = this._getSceneCombat();
    if (!combat) return ui.notifications?.warn?.(t("OLATTACK.Scene.NoCombat"));
    try {
      if (typeof combat.endCombat === "function") await combat.endCombat();
      else await combat.delete();
    } catch {
      try { await combat.delete(); } catch {}
    }
    this.displayMode = "overview";
    this._persistState();
    this.render();
  }

  async _rollInitiativeForSelection(scope = "all", singleTokenId = null) {
    if (scope === "one" && singleTokenId && !this.combatTokenIds.length) this.combatTokenIds = [String(singleTokenId)];
    if (!this.combatTokenIds.length && scope !== "one") {
      const configured = await this._openSelectionConfig();
      if (!configured) return;
    }
    if (!this.combatTokenIds.length && scope !== "one") {
      ui.notifications?.warn?.(t("OLATTACK.Scene.PickBeforeInit"));
      return;
    }
    const combat = await this._syncCombatParticipants();
    if (!combat) return;

    const tokens = this._getSceneTokens();
    const tokenMap = new Map(tokens.map((tk) => [String(tk.id), tk]));
    let tokenIds = this._getEffectiveCombatIds(tokens);
    if (scope === "npc") tokenIds = tokenIds.filter((id) => !tokenMap.get(String(id))?.actor?.hasPlayerOwner);
    if (scope === "one" && singleTokenId) tokenIds = [String(singleTokenId)];
    if (!tokenIds.length) {
      ui.notifications?.warn?.(t("OLATTACK.Scene.NoValidParticipants"));
      return;
    }

    const combatantIds = Array.from(combat.combatants || [])
      .filter((c) => tokenIds.includes(String(c.tokenId)))
      .map((c) => c.id)
      .filter(Boolean);
    if (!combatantIds.length) {
      ui.notifications?.warn?.(t("OLATTACK.Scene.NoCombatantsFound"));
      return;
    }

    await combat.rollInitiative(combatantIds);
    this.displayMode = "combat";
    this._persistState();
    this.render();
  }

  async _promptSetHp(tokenId) {
    const actor = this._getTokenById(tokenId)?.actor;
    if (!actor) return;
    const hp = getActorHpData(actor);
    const max = safeNum(hp.max, 0);
    const next = await olNumber({
      title: t("OLATTACK.Main.EditHpTitle", { name: actor.name }),
      label: t("OLATTACK.Main.EditHpLabel", { max }),
      value: safeNum(hp.value, 0), min: 0, max
    });
    if (next === null || next === undefined) return;
    await updateActorHpData(actor, { value: next });
    this.render();
  }

  // ---------- Hooks ----------
  _registerHooks() {
    if (this._hookIds.length) return;
    const refresh = () => this._queueRefresh();
    const on = (hook, fn = refresh) => this._hookIds.push([hook, Hooks.on(hook, fn)]);
    on("updateActor", (actor, changes) => { if (actorChangeMatters(changes)) refresh(); });
    on("updateToken", (doc, changes) => { if (tokenChangeMatters(changes)) refresh(); });
    on("targetToken", (user) => { if (user?.id === game.user?.id) refresh(); });
    [
      "updateItem", "createItem", "deleteItem",
      "updateActiveEffect", "createActiveEffect", "deleteActiveEffect",
      "createToken", "deleteToken", "canvasReady", "updateCombat", "combatTurn", "combatRound",
      "combatStart", "createCombat", "deleteCombat", "createCombatant", "deleteCombatant", "updateCombatant"
    ].forEach((hook) => on(hook));
  }

  async close(options = {}) {
    clearTimeout(this._refreshTimer);
    clearTimeout(this._publishTimer);
    closeOlContextMenu();
    try { await this._publishPlayerSceneState(true); } catch (_) {}
    await this._persistState();
    for (const [hook, id] of this._hookIds) Hooks.off(hook, id);
    this._hookIds = [];
    this._sceneConfigApp?.close?.();
    game.olAttack?.clearHandledToken?.();
    this.gmHandledTokenId = "";
    return super.close(options);
  }
}
