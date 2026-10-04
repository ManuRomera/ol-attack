import { SOCKET_NS } from "../shared/constants.js";
import { OLApp } from "./base-app.js";
import { jq } from "../shared/compat.js";
import { safeNum } from "../lib/utils.js";
import { openOlContextMenu, closeOlContextMenu } from "../lib/context-menu.js";
import { leer as leerMemoria, recordar } from "../lib/memoria.js";
import {
  defaultVisualSettings, defaultPlayerViewConfig, buildRow, redactRow, buildCombatMeta, isOwnedByCurrentUser
} from "../lib/scene-rows.js";
import { tokenChangeMatters, actorChangeMatters } from "./scene-tracker-app.js";

const t = (key, data) => game.i18n.format(key, data ?? {});
const orientation = (v) => (["horizontal", "vertical"].includes(String(v)) ? String(v) : "horizontal");

/** Monitor resumido de combate para jugadores. Muestra solo lo que el GM ha publicado. */
export class OLSceneTrackerPlayerApp extends OLApp {
  static MEMORIA = "scene-tracker-player";
  static DRAG_ANYWHERE = true;

  static DEFAULT_OPTIONS = {
    id: "ol-scene-tracker-player-app",
    classes: ["ol-attack", "ol-window", "ol-scene-tracker", "ol-scene-tracker-player"],
    position: { width: 820, height: 440 },
    window: { title: "OLATTACK.Scene.PlayerTitle", icon: "fa-solid fa-table-columns", resizable: true, minimizable: true }
  };

  static PARTS = {
    main: { template: "modules/ol-attack/templates/scene-tracker-player-app.hbs", scrollable: [".ol-scene-grid"] }
  };

  constructor(options = {}) {
    super(options);
    this.publicState = foundry.utils.deepClone(options.publicState || {});
    // La orientación es una preferencia de este navegador.
    this.combatOrientation = orientation(leerMemoria(this.constructor.MEMORIA).orientacion);
    this._hookIds = [];
  }

  setPublicState(state = {}) {
    this.publicState = foundry.utils.deepClone(state || {});
    if (!this.publicState?.active || String(this.publicState?.displayMode || "") !== "combat") {
      this.close();
      return;
    }
    if (this.rendered) this.render();
  }

  _getVisualSettings() {
    return foundry.utils.mergeObject(defaultVisualSettings(), foundry.utils.deepClone(this.publicState?.visualSettings || {}));
  }

  _getSceneCombat() {
    return game.combats?.find?.((c) => String(c.scene?.id || c.scene) === String(canvas?.scene?.id || "")) || null;
  }

  _getRows() {
    const sceneId = this.publicState?.sceneId;
    if (!canvas?.scene || (sceneId && String(canvas.scene.id) !== String(sceneId))) return [];
    const orderedIds = Array.isArray(this.publicState?.orderedTokenIds) ? this.publicState.orderedTokenIds.map(String) : [];
    const playerCfg = foundry.utils.mergeObject(defaultPlayerViewConfig(), foundry.utils.deepClone(this.publicState?.playerViewConfig || {}));
    const visuals = this._getVisualSettings();
    const opacityMap = this.publicState?.visualTokenOpacity || {};
    const imageChoiceMap = this.publicState?.visualTokenImageChoice || {};
    const combat = this._getSceneCombat();
    const turnOrder = new Map(Array.from(combat?.turns || []).map((c, idx) => [String(c.tokenId), idx]));
    const combatantByToken = new Map(Array.from(combat?.combatants || []).map((c) => [String(c.tokenId), c]));
    const activeTokenId = String(combat?.combatant?.tokenId || "");
    const targetedTokenId = String(Array.from(game.user?.targets || [])[0]?.id || "");
    const out = [];
    for (const id of orderedIds) {
      const token = canvas.tokens?.get?.(id);
      if (!token?.actor) continue;
      const isPC = !!token.actor.hasPlayerOwner;
      const owned = isOwnedByCurrentUser(token.actor);
      if (!owned && isPC && !playerCfg.showPCs) continue;
      if (!owned && !isPC && !playerCfg.showNPCs) continue;
      const row = buildRow(token, {
        initiative: combatantByToken.get(id)?.initiative,
        turnIndex: turnOrder.has(id) ? turnOrder.get(id) + 1 : null,
        isActiveTurn: activeTokenId === id,
        opacity: opacityMap[id],
        isOwnedByUser: owned,
        targetedTokenId,
        imageChoice: imageChoiceMap[id] || {}
      }, { visuals, player: true, resourceLimit: owned ? Infinity : 8, withSlots: owned });
      if (!owned && !isPC) {
        redactRow(row);
      } else {
        Object.assign(row, {
          showHP: owned || !!playerCfg.showHP,
          showTempHP: owned || !!playerCfg.showTempHP,
          showResources: owned || !!playerCfg.showResources,
          showSpellSlots: owned,
          showStatuses: owned || !!playerCfg.showStatuses,
          showQuickTraits: owned || !!playerCfg.showQuickTraits,
          showWeaknesses: owned || !!playerCfg.showWeaknesses,
          showWeaknessDetails: owned,
          showDeath: owned && !!row.death?.visible
        });
      }
      row.canRollInitiative = row.isOwnedByUser && !row.hasInitiative;
      out.push(row);
    }
    return out;
  }

  async getData() {
    const rows = this._getRows();
    const publicMeta = this.publicState?.combatMeta || {};
    return {
      hasScene: !!canvas?.scene,
      sceneName: this.publicState?.sceneName || canvas?.scene?.name || t("OLATTACK.Scene.CurrentScene"),
      rows,
      combatMeta: buildCombatMeta(rows, {
        combatRound: Number(publicMeta.combatRound) || Number(publicMeta.round) || 0,
        combatStarted: !!publicMeta.combatStarted,
        activeName: publicMeta.activeName || null
      }),
      isCombatMode: true,
      isCombatVertical: this.combatOrientation === "vertical"
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._registerHooks();
  }

  _queueRefresh() {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => { if (this.rendered) this.render(); }, 120);
  }

  activateListeners(html) {
    html.on("click", '[data-action="refresh"]', (ev) => { ev.preventDefault(); this.render(); });
    html.on("click", '[data-action="toggle-orientation"]', (ev) => {
      ev.preventDefault();
      this.combatOrientation = this.combatOrientation === "vertical" ? "horizontal" : "vertical";
      recordar(this.constructor.MEMORIA, { orientacion: this.combatOrientation });
      this.render();
    });
    html.on("click", '[data-action="roll-initiative-one"]', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const tokenId = String(ev.currentTarget.dataset.tokenId || "");
      if (tokenId) await this._requestInitiativeRoll([tokenId]);
    });

    html.on("dblclick", ".ol-scene-card[data-token-id]", async (ev) => {
      if (jq(ev.target).closest("button, input, select, textarea, a, [data-action]").length) return;
      ev.preventDefault();
      ev.stopPropagation();
      const token = this._getTokenById(String(ev.currentTarget.dataset.tokenId || ""));
      if (token?.actor && isOwnedByCurrentUser(token.actor)) game.olAttack?.open?.({ actor: token.actor, token });
    });

    html.on("contextmenu", ".ol-scene-card[data-token-id]", async (ev) => {
      if (jq(ev.target).closest("button, input, select, textarea, a, [data-action]").length) return;
      ev.preventDefault();
      ev.stopPropagation();
      const tokenId = String(ev.currentTarget.dataset.tokenId || "");
      if (tokenId) await this._openTokenContextMenu(tokenId, { x: ev.clientX, y: ev.clientY });
    });
  }

  async _openTokenContextMenu(tokenId, point = {}) {
    const token = this._getTokenById(tokenId);
    if (!token?.actor) return;
    const isTargeted = Array.from(game.user?.targets || []).some((tk) => String(tk.id) === String(tokenId));
    const owned = isOwnedByCurrentUser(token.actor);
    const combatant = Array.from(this._getSceneCombat()?.combatants || []).find((c) => String(c.tokenId) === String(tokenId));
    const hasInitiative = combatant?.initiative !== null && combatant?.initiative !== undefined;
    closeOlContextMenu();
    openOlContextMenu({
      x: safeNum(point.x, window.innerWidth / 2),
      y: safeNum(point.y, window.innerHeight / 2),
      title: token.name || token.actor.name,
      items: [
        { label: t(isTargeted ? "OLATTACK.Ctx.Untarget" : "OLATTACK.Ctx.Target"), action: () => this._toggleTargetToken(tokenId, !isTargeted) },
        ...(owned ? [{
          label: t(hasInitiative ? "OLATTACK.Scene.InitDone" : "OLATTACK.Scene.RollInitOne"),
          disabled: !!hasInitiative,
          action: () => this._requestInitiativeRoll([tokenId])
        }] : [])
      ]
    });
  }

  _getTokenById(tokenId) {
    return canvas?.tokens?.get?.(String(tokenId || "")) || null;
  }

  async _toggleTargetToken(tokenId, state = true) {
    const token = this._getTokenById(tokenId);
    if (!token) return;
    try {
      token.setTarget(!!state, { user: game.user, releaseOthers: !!state, groupSelection: false });
    } catch (_) {
      ui.notifications?.warn?.(t("OLATTACK.Scene.TargetFailed"));
    }
  }

  async _requestInitiativeRoll(tokenIds = []) {
    const validIds = Array.from(new Set((tokenIds || []).map(String))).filter(Boolean);
    if (!validIds.length) {
      ui.notifications?.warn?.(t("OLATTACK.Scene.NoValidChars"));
      return;
    }
    try {
      game.socket?.emit?.(SOCKET_NS, { type: "playerRollInitiative", userId: game.user?.id, sceneId: canvas?.scene?.id || null, tokenIds: validIds });
      ui.notifications?.info?.(t(validIds.length > 1 ? "OLATTACK.Scene.InitRequestedMany" : "OLATTACK.Scene.InitRequested"));
    } catch (_) {
      ui.notifications?.warn?.(t("OLATTACK.Scene.InitRequestFailed"));
    }
  }

  _registerHooks() {
    if (this._hookIds.length) return;
    const refresh = () => this._queueRefresh();
    const on = (hook, fn = refresh) => this._hookIds.push([hook, Hooks.on(hook, fn)]);
    on("updateActor", (actor, changes) => { if (actorChangeMatters(changes)) refresh(); });
    on("updateToken", (doc, changes) => { if (tokenChangeMatters(changes)) refresh(); });
    on("targetToken", (user) => { if (user?.id === game.user?.id) refresh(); });
    [
      "updateItem", "createItem", "deleteItem", "updateActiveEffect", "createActiveEffect", "deleteActiveEffect",
      "createToken", "deleteToken", "canvasReady", "updateCombat", "combatTurn", "combatRound", "combatStart",
      "createCombat", "deleteCombat", "createCombatant", "deleteCombatant", "updateCombatant"
    ].forEach((hook) => on(hook));
  }

  async close(options = {}) {
    clearTimeout(this._refreshTimer);
    closeOlContextMenu();
    for (const [hook, id] of this._hookIds) Hooks.off(hook, id);
    this._hookIds = [];
    return super.close(options);
  }
}
