import { getActorContext } from "./lib/actor.js";
import { OLAttackApp } from "./ui/ol-attack-app.js";
import { OLSceneTrackerApp } from "./ui/scene-tracker-app.js";
import { OLSceneTrackerPlayerApp } from "./ui/scene-tracker-player-app.js";
import { ActionProfileConfigApp } from "./ui/action-profile-config.js";
import { i18n } from "./shared/i18n.js";

export class OLAttackAPI {
  constructor() {
    this._sceneTracker = null;
    this._gmHandledTokenId = null;
    this._playerSceneTracker = null;
  }

  /**
   * Abre la ventana OL Attack.
   * @param {object} [opts]
   * @param {Actor} [opts.actor]
   * @param {Token} [opts.token]
   */
  open(opts = {}) {
    const { actor, token } = getActorContext(opts);
    if (!actor) return ui.notifications.error(i18n("OLATTACK.NoActor"));
    const app = new OLAttackApp({ actor, token });
    return app.render(true);
  }


  setHandledToken(tokenOrId = null) {
    const id = typeof tokenOrId === 'string' ? tokenOrId : tokenOrId?.id;
    this._gmHandledTokenId = id ? String(id) : null;
    return this.getHandledToken();
  }

  clearHandledToken() {
    this._gmHandledTokenId = null;
    this._playerSceneTracker = null;
  }

  getHandledToken() {
    if (!this._gmHandledTokenId) return null;
    if (!this._sceneTracker?.rendered) return null;
    return canvas?.tokens?.get?.(this._gmHandledTokenId)
      || canvas?.tokens?.placeables?.find?.((t) => String(t.id) === String(this._gmHandledTokenId))
      || null;
  }

  openActionProfileConfig(opts = {}) {
    if (!game.user?.isGM) return ui.notifications.warn("Solo el GM puede configurar perfiles de acción.");
    const app = new ActionProfileConfigApp(opts);
    return app.render(true);
  }

  openSceneTracker(opts = {}) {
    if (!game.user?.isGM) {
      let state = opts?.publicState || opts || {};
      if (!state || !Object.keys(state).length) {
        try { state = game.settings.get('ol-attack', 'playerScenePublicState') || {}; }
        catch (_) { state = {}; }
      }
      if (state?.active && String(state.displayMode || '') === 'combat') {
        return this.openPlayerSceneTracker({ publicState: state });
      }
      if (this._playerSceneTracker?.rendered) {
        this._playerSceneTracker.render(true);
        return this._playerSceneTracker;
      }
      return this.reopenPlayerSceneTracker();
    }
    if (this._sceneTracker?.rendered) {
      if (opts?.displayMode) this._sceneTracker.displayMode = String(opts.displayMode);
      this._sceneTracker.render(true);
      return this._sceneTracker;
    }
    this._sceneTracker = new OLSceneTrackerApp(opts);
    this._sceneTracker.render(true);
    return this._sceneTracker;
  }

  openPlayerSceneTracker(opts = {}) {
    if (game.user?.isGM) return null;
    let state = opts?.publicState || opts || {};
    if (!state || !Object.keys(state).length) {
      try { state = game.settings.get('ol-attack', 'playerScenePublicState') || {}; }
      catch (_) { state = {}; }
    }
    if (this._playerSceneTracker) {
      this._playerSceneTracker.setPublicState?.(state);
      this._playerSceneTracker.render(true);
      return this._playerSceneTracker;
    }
    this._playerSceneTracker = new OLSceneTrackerPlayerApp({ publicState: state });
    this._playerSceneTracker.render(true);
    return this._playerSceneTracker;
  }

  reopenPlayerSceneTracker() {
    if (game.user?.isGM) return null;
    let state = {};
    try {
      state = game.settings.get("ol-attack", "playerScenePublicState") || {};
    } catch (_) {
      state = {};
    }
    if (!state?.active || String(state.displayMode || '') !== 'combat') {
      ui.notifications?.warn?.('El monitor resumido no está activo ahora mismo.');
      return null;
    }
    return this.openPlayerSceneTracker({ publicState: state });
  }

  async closePlayerSceneTracker() {
    if (!this._playerSceneTracker) return;
    const app = this._playerSceneTracker;
    this._playerSceneTracker = null;
    try { await app.close(); } catch (_) {}
  }

  receivePlayerSceneState(state = {}) {
    if (game.user?.isGM) return null;
    if (!state?.active || String(state.displayMode || '') !== 'combat') {
      this.closePlayerSceneTracker();
      return null;
    }
    return this.openPlayerSceneTracker({ publicState: state });
  }
}
