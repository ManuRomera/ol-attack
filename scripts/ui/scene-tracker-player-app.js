import { gp, safeNum } from "../lib/utils.js";
import { MODULE_ID, SETTING_PLAYER_SCENE_WINDOW_STATE } from "../shared/constants.js";
import { LegacyApplication, LegacyDialog } from "../shared/compat.js";
import { getItemUses } from "../lib/uses.js";
import { getAvailableSpellSlots } from "../lib/spells.js";
import { getActorHpData, getActorDeathSaveData, getActorTraits } from "../shared/system-data.js";
import { openOlContextMenu, closeOlContextMenu } from "../lib/context-menu.js";
import { SOCKET_NS } from "../shared/constants.js";

function _norm(value) {
  return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
function _clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function _mixHex(a, b, t) {
  const pa = a.replace('#', '');
  const pb = b.replace('#', '');
  const ar = parseInt(pa.slice(0, 2), 16); const ag = parseInt(pa.slice(2, 4), 16); const ab = parseInt(pa.slice(4, 6), 16);
  const br = parseInt(pb.slice(0, 2), 16); const bg = parseInt(pb.slice(2, 4), 16); const bb = parseInt(pb.slice(4, 6), 16);
  const lerp = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${lerp(ar, br)}, ${lerp(ag, bg)}, ${lerp(ab, bb)})`;
}
function _hpColorByRatio(ratio) {
  const r = _clamp(Number(ratio) || 0, 0, 1);
  if (r >= 0.5) return _mixHex('#d97706', '#1f9d55', (r - 0.5) / 0.5);
  if (r >= 0.25) return _mixHex('#b91c1c', '#d97706', (r - 0.25) / 0.25);
  return _mixHex('#050505', '#b91c1c', r / 0.25);
}
function _getHpDisplay(hp = {}) {
  const value = Math.max(0, safeNum(hp.value, 0));
  const max = Math.max(0, safeNum(hp.max, 0));
  const temp = Math.max(0, safeNum(hp.temp, 0));
  const ratio = max > 0 ? _clamp(value / max, 0, 1) : 0;
  return {
    value, max, temp, ratio,
    fillStyle: `width:${Math.round(ratio * 1000) / 10}%; background:${_hpColorByRatio(ratio)};`,
    tempFillStyle: temp > 0 ? 'width:100%; background:rgba(31,157,85,.9);' : 'width:0%; background:transparent;',
    tempActive: temp > 0
  };
}
function _getDeathSaveDisplay(actor, hp = {}) {
  const death = getActorDeathSaveData(actor);
  const success = Math.max(0, Math.min(3, safeNum(death.success, 0)));
  const failure = Math.max(0, Math.min(3, safeNum(death.failure, 0)));
  const max = Math.max(0, safeNum(hp.max, 0));
  const value = Math.max(0, safeNum(hp.value, 0));
  const visible = max > 0 && value <= 0;
  return {
    visible,
    successes: success,
    failures: failure,
    stateLabel: value > 0 ? 'Estable' : (failure >= 3 ? 'Muerte' : (success >= 3 ? 'Estable' : 'Agonía')),
    successDots: Array.from({ length: 3 }, (_, idx) => ({ idx: idx + 1, filled: idx < success })),
    failureDots: Array.from({ length: 3 }, (_, idx) => ({ idx: idx + 1, filled: idx < failure }))
  };
}

function _resourcePriority(item) {
  const hay = `${_norm(item?.name)} ${_norm(gp(item, "system.identifier") || "")}`.trim();
  const hit = (...parts) => parts.some((p) => hay.includes(_norm(p)));
  if (hit("rage", "furia", "rabia")) return 10;
  if (hit("frenzy", "frenesi")) return 15;
  if (hit("wails from the grave", "lamentos desde la tumba", "lamentos de la tumba")) return 20;
  if (hit("bardic inspiration", "inspiracion bardica")) return 30;
  if (hit("lucky", "afortunad", "suerte")) return 40;
  if (hit("channel divinity", "canalizar")) return 50;
  if (hit("warding flare", "destello protector", "llamarada protectora")) return 60;
  return 100;
}
function _effectStatusKeys(effect) {
  const raw = effect?.statuses;
  if (!raw) return [];
  try {
    if (Array.isArray(raw)) return raw.map((v) => String(v || ''));
    if (raw instanceof Set) return Array.from(raw).map((v) => String(v || ''));
    if (typeof raw.values === 'function') return Array.from(raw.values()).map((v) => String(v || ''));
  } catch (_) {}
  return [];
}
function _hasConcentration(actor) {
  try {
    const effectHit = Array.from(actor?.effects || []).some((effect) => {
      if (!effect || effect.disabled) return false;
      const label = _norm(effect.name || effect.label || '');
      const icon = _norm(effect.img || effect.icon || '');
      const statuses = _effectStatusKeys(effect).map(_norm);
      const dnd5eConcentration = gp(effect, 'flags.dnd5e.concentration') || gp(effect, 'flags.dnd5e.isConcentration');
      return label.includes('concentr') || icon.includes('concentr') || dnd5eConcentration === true || statuses.some((s) => s.includes('concentr'));
    });
    if (effectHit) return true;
  } catch (_) {}
  return false;
}
function _hasNamedFeature(actor, keys = []) {
  const itemList = actor?.items?.contents || actor?.items || [];
  return Array.from(itemList).some((item) => {
    const hay = `${_norm(item?.name)} ${_norm(gp(item, 'system.identifier') || '')}`.trim();
    return keys.some((key) => hay.includes(_norm(key)));
  });
}
function _collectQuickTraits(actor) {
  const out = [];
  if (_hasConcentration(actor)) out.push({ id: 'concentration', label: 'Concentración', shortLabel: 'Conc.', tone: 'magic' });
  if (_hasNamedFeature(actor, ['multiattack', 'multiataque', 'ataque multiple', 'ataque múltiple'])) out.push({ id: 'multiattack', label: 'Multiataque', shortLabel: 'Multiat.', tone: 'feature' });
  if (_hasNamedFeature(actor, ['legendary resistance', 'resistencia legendaria'])) out.push({ id: 'legendary-resistance', label: 'Resistencia legendaria', shortLabel: 'RL', tone: 'feature' });
  return out;
}
function _collectStatuses(actor) {
  const out = [];
  for (const effect of actor?.effects || []) {
    if (!effect || effect.disabled) continue;
    const label = String(effect.name || effect.label || "").trim();
    const icon = effect.img || effect.icon || "icons/svg/aura.svg";
    if (!label) continue;
    out.push({ id: effect.id || `${label}-${icon}`, label, icon });
  }
  const seen = new Set();
  return out.filter((s) => { const key = `${s.label}__${s.icon}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
function _collectResources(actor, limit = 8) {
  const items = actor?.items?.contents || actor?.items || [];
  const out = [];
  for (const item of items) {
    const uses = getItemUses(item);
    if (uses.max <= 0) continue;
    const type = String(item?.type || "");
    const include = ["spell", "feat", "class", "consumable"].includes(type) || _resourcePriority(item) < 100;
    if (!include) continue;
    out.push({ id: item.id, name: item.name, shortName: item.name, remaining: uses.remaining, max: uses.max, priority: _resourcePriority(item), depleted: uses.remaining <= 0 });
  }
  out.sort((a, b) => Number(a.depleted) - Number(b.depleted) || a.priority - b.priority || a.name.localeCompare(b.name, 'es'));
  const maxRows = Number.isFinite(Number(limit)) ? Number(limit) : out.length;
  return maxRows >= out.length ? out : out.slice(0, Math.max(0, maxRows));
}
function _collectSpellSlots(actor) {
  return getAvailableSpellSlots(actor).map((slot) => ({
    key: slot.key,
    level: slot.level,
    value: slot.value,
    max: slot.max,
    label: slot.key === 'pact' ? `Pacto ${slot.level}` : `Nivel ${slot.level}`,
    shortLabel: slot.key === 'pact' ? `P${slot.level}` : `N${slot.level}`,
    depleted: Number(slot.value || 0) <= 0
  }));
}

function _normalizeTraitEntries(raw, custom) {
  const arr = [];
  try {
    const values = Array.isArray(raw?.value) ? raw.value : (raw?.value instanceof Set ? Array.from(raw.value) : []);
    for (const v of values) if (String(v || '').trim()) arr.push(String(v).trim());
  } catch (_) {}
  if (String(custom || '').trim()) arr.push(String(custom).trim());
  return arr;
}
function _collectWeaknessSummary(actor) {
  const traits = getActorTraits(actor) || {};
  return {
    vulnerability: _normalizeTraitEntries(traits.dv, traits.dv?.custom),
    resistance: _normalizeTraitEntries(traits.dr, traits.dr?.custom),
    immunity: _normalizeTraitEntries(traits.di, traits.di?.custom)
  };
}
function _isVideoPath(src) {
  const value = String(src || '').trim().toLowerCase();
  return /\.(mp4|webm|ogg|m4v)(\?.*)?$/.test(value);
}

function _isGenericPortrait(img) {
  const s = String(img || '').toLowerCase();
  return !s || s.endsWith('/icons/svg/mystery-man.svg') || s.endsWith('/icons/svg/hazard.svg') || s.endsWith('/icons/svg/book.svg');
}
function _collectAvailablePortraitOptions(actor, token) {
  const actorImg = String(actor?.img || '').trim();
  const tokenImg = String(token?.document?.texture?.src || token?.texture?.src || token?.document?.img || token?.img || '').trim();
  const prototypeImg = String(gp(actor, 'prototypeToken.texture.src') || gp(actor, 'prototypeToken.img') || '').trim();
  const entries = [
    { key: 'actor', label: 'Retrato del actor', src: actorImg },
    { key: 'token', label: 'Imagen del token', src: tokenImg },
    { key: 'prototype', label: 'Imagen del prototipo', src: prototypeImg }
  ];
  const seen = new Set();
  return entries.filter((entry) => {
    const src = String(entry.src || '').trim();
    if (!src) return false;
    if (seen.has(src)) return false;
    seen.add(src);
    return true;
  });
}
function _resolvePortraitChoice(actor, token, choice = {}) {
  const available = _collectAvailablePortraitOptions(actor, token);
  const actorImg = available.find((o) => o.key === 'actor')?.src || String(actor?.img || '').trim();
  const tokenImg = available.find((o) => o.key === 'token')?.src || String(token?.document?.texture?.src || token?.texture?.src || token?.document?.img || token?.img || '').trim();
  const prototypeImg = available.find((o) => o.key === 'prototype')?.src || String(gp(actor, 'prototypeToken.texture.src') || gp(actor, 'prototypeToken.img') || '').trim();
  const mode = String(choice?.mode || 'auto');
  const custom = String(choice?.custom || '').trim();
  const genericActor = _isGenericPortrait(actorImg);
  const autoPortrait = !genericActor ? actorImg : (tokenImg || prototypeImg || actorImg || 'icons/svg/mystery-man.svg');
  const autoAvatar = tokenImg || prototypeImg || (!genericActor ? actorImg : '') || 'icons/svg/mystery-man.svg';
  let portrait = autoPortrait;
  if (mode === 'custom' && custom) portrait = custom;
  else if (mode === 'actor') portrait = actorImg || tokenImg || prototypeImg || autoPortrait;
  else if (mode === 'token') portrait = tokenImg || prototypeImg || actorImg || autoPortrait;
  else if (mode === 'prototype') portrait = prototypeImg || tokenImg || actorImg || autoPortrait;
  return { portrait: portrait || autoPortrait, avatar: autoAvatar, available, mode, custom };
}
function _pickPortraits(actor, token, choice = {}) {
  return _resolvePortraitChoice(actor, token, choice);
}

function _defaultVisualSettings() { return { usePortraitBackground: true, backgroundOpacity: 40, overlayOpacity: 60, backgroundSize: 'cover' }; }
function _defaultPlayerViewConfig() { return { showPCs: true, showNPCs: true, showHP: true, showTempHP: true, showResources: false, showStatuses: true, showQuickTraits: true, showWeaknesses: false }; }

function _isOwnedByCurrentUser(actor) {
  try { return !!actor?.testUserPermission?.(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER); } catch (_) {}
  try { return !!actor?.isOwner; } catch (_) {}
  return false;
}

function _buildCombatMetaLocal(rows = [], publicMeta = {}) {
  const selectedCount = rows.length;
  const rolledCount = rows.filter((r) => r.hasInitiative).length;
  const pendingCount = Math.max(0, selectedCount - rolledCount);
  const pendingPlayers = rows.filter((r) => r.isPC && !r.hasInitiative).length;
  const pendingNpcs = rows.filter((r) => !r.isPC && !r.hasInitiative).length;
  return {
    combatRound: Number(publicMeta?.combatRound) || Number(publicMeta?.round) || 0,
    combatStarted: !!publicMeta?.combatStarted,
    selectedCount,
    rolledCount,
    pendingCount,
    pendingPlayers,
    pendingNpcs,
    activeName: publicMeta?.activeName || null
  };
}

function _redactEnemyRow(row) {
  row.hp = _getHpDisplay({ value: 0, max: 0, temp: 0 });
  row.death = { visible: false, successes: 0, failures: 0, stateLabel: '', successDots: [], failureDots: [] };
  row.resources = [];
  row.spellSlots = [];
  row.statuses = [];
  row.quickTraits = [];
  row.weaknesses = { vulnerability: [], resistance: [], immunity: [] };
  row.showHP = false;
  row.showTempHP = false;
  row.showDeath = false;
  row.showResources = false;
  row.showSpellSlots = false;
  row.showStatuses = false;
  row.showQuickTraits = false;
  row.showWeaknesses = false;
  row.showWeaknessDetails = false;
  row.enemyPrivate = true;
  return row;
}

function _buildRow(token, extra = {}, visuals = _defaultVisualSettings()) {
  const actor = token?.actor;
  const portraits = _pickPortraits(actor, token, extra.imageChoice || {});
  const hp = _getHpDisplay(getActorHpData(actor));
  const death = _getDeathSaveDisplay(actor, hp);
  const weaknesses = _collectWeaknessSummary(actor);
  const opacity = _clamp((Number(extra.opacity ?? visuals.backgroundOpacity) || 40) / 100, 0, 0.95);
  const overlay = _clamp((Number(visuals.overlayOpacity) || 60) / 100, 0.05, 0.95);
  const bgSize = ['cover', 'contain'].includes(String(visuals.backgroundSize || 'cover')) ? String(visuals.backgroundSize) : 'cover';
  const bgMedia = String(portraits.portrait || portraits.avatar || '').trim();
  const bgMediaIsVideo = _isVideoPath(bgMedia);
  const targetedTokenId = String(extra.targetedTokenId || '');
  return {
    tokenId: String(token.id),
    tokenName: token.name || actor?.name,
    img: portraits.avatar,
    actorImg: portraits.portrait,
    bgMedia,
    bgMediaIsVideo,
    isPC: !!actor?.hasPlayerOwner,
    hidden: !!token.document?.hidden,
    hp,
    death,
    resources: _collectResources(actor, extra.showAllResources ? Number.MAX_SAFE_INTEGER : 8),
    spellSlots: _collectSpellSlots(actor),
    statuses: _collectStatuses(actor),
    quickTraits: _collectQuickTraits(actor),
    weaknesses,
    initiative: Number.isFinite(Number(extra.initiative)) ? Number(extra.initiative) : null,
    hasInitiative: Number.isFinite(Number(extra.initiative)),
    turnIndex: Number.isFinite(Number(extra.turnIndex)) ? Number(extra.turnIndex) : null,
    isActiveTurn: !!extra.isActiveTurn,
    isOwnedByUser: !!extra.isOwnedByUser,
    isTargetedByUser: !!targetedTokenId && targetedTokenId === String(token.id),
    hasPortraitBackground: !!visuals.usePortraitBackground && !!bgMedia,
    cardStyle: visuals.usePortraitBackground ? `--ol-card-bg-opacity:${opacity}; --ol-card-overlay-opacity:${overlay}; --ol-card-bg-size:${bgSize};` : '',
    showAvatar: !visuals.usePortraitBackground
  };
}

export class OLSceneTrackerPlayerApp extends LegacyApplication {
  constructor(options = {}) {
    super(options);
    this.publicState = foundry.utils.deepClone(options.publicState || {});
    this.state = this._loadState();
    this.combatOrientation = ['horizontal', 'vertical'].includes(String(this.state.combatOrientation || 'horizontal')) ? String(this.state.combatOrientation) : 'horizontal';
    this._hookIds = [];
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'ol-scene-tracker-player-app',
      title: 'OL Monitor de Combate',
      template: 'modules/ol-attack/templates/scene-tracker-player-app.hbs',
      classes: ['ol-attack', 'ol-window-theme', 'ol-scene-tracker', 'ol-scene-tracker-player'],
      width: 860,
      height: 520,
      minWidth: 680,
      minHeight: 420,
      resizable: true,
      minimizable: true
    });
  }

  _loadState() {
    const fallback = { left: null, top: null, width: 860, height: 520, combatOrientation: 'horizontal' };
    try {
      const stored = game.settings.get(MODULE_ID, SETTING_PLAYER_SCENE_WINDOW_STATE) || {};
      return foundry.utils.mergeObject(foundry.utils.deepClone(fallback), foundry.utils.deepClone(stored));
    } catch (_) { return foundry.utils.deepClone(fallback); }
  }

  async _saveState() {
    try {
      const pos = this.position || {};
      this.state = {
        left: Number.isFinite(Number(pos.left)) ? Number(pos.left) : this.state?.left ?? null,
        top: Number.isFinite(Number(pos.top)) ? Number(pos.top) : this.state?.top ?? null,
        width: Number.isFinite(Number(pos.width)) ? Number(pos.width) : this.state?.width ?? 860,
        height: Number.isFinite(Number(pos.height)) ? Number(pos.height) : this.state?.height ?? 520,
        combatOrientation: ['horizontal', 'vertical'].includes(String(this.combatOrientation)) ? String(this.combatOrientation) : 'horizontal'
      };
      await game.settings.set(MODULE_ID, SETTING_PLAYER_SCENE_WINDOW_STATE, this.state);
    } catch (_) {}
  }

  setPublicState(state = {}) {
    this.publicState = foundry.utils.deepClone(state || {});
    if (!this.publicState?.active || String(this.publicState?.displayMode || '') !== 'combat') {
      this.close();
      return;
    }
    if (this.rendered) this.render(false);
  }

  _getVisualSettings() {
    return foundry.utils.mergeObject(_defaultVisualSettings(), foundry.utils.deepClone(this.publicState?.visualSettings || {}));
  }

  _getRows() {
    const sceneId = this.publicState?.sceneId;
    if (!canvas?.scene || (sceneId && String(canvas.scene.id) !== String(sceneId))) return [];
    const orderedIds = Array.isArray(this.publicState?.orderedTokenIds) ? this.publicState.orderedTokenIds.map(String) : [];
    const playerCfg = foundry.utils.mergeObject(_defaultPlayerViewConfig(), foundry.utils.deepClone(this.publicState?.playerViewConfig || {}));
    const visuals = this._getVisualSettings();
    const opacityMap = foundry.utils.deepClone(this.publicState?.visualTokenOpacity || {});
    const imageChoiceMap = foundry.utils.deepClone(this.publicState?.visualTokenImageChoice || {});
    const combat = game.combats?.find?.((c) => String(c.scene?.id || c.scene) === String(canvas.scene.id)) || null;
    const turnOrder = new Map(Array.from(combat?.turns || []).map((c, idx) => [String(c.tokenId), idx]));
    const activeTokenId = String(combat?.combatant?.tokenId || '');
    const targetedTokenId = String(Array.from(game.user?.targets || [])[0]?.id || '');
    const out = [];
    for (const id of orderedIds) {
      const token = canvas.tokens?.get?.(id) || canvas.tokens?.placeables?.find?.((t) => String(t.id) === id);
      if (!token?.actor) continue;
      const isPC = !!token.actor.hasPlayerOwner;
      const owned = _isOwnedByCurrentUser(token.actor);
      const enemyPrivate = !owned && !isPC;
      if (!owned && isPC && !playerCfg.showPCs) continue;
      if (!owned && !isPC && !playerCfg.showNPCs) continue;
      const row = _buildRow(token, {
        initiative: combat?.combatants?.find?.((c) => String(c.tokenId) === id)?.initiative,
        turnIndex: turnOrder.has(id) ? turnOrder.get(id) + 1 : null,
        isActiveTurn: activeTokenId === id,
        opacity: opacityMap[id],
        isOwnedByUser: owned,
        targetedTokenId,
        showAllResources: owned,
        imageChoice: imageChoiceMap[id] || {}
      }, visuals);
      if (enemyPrivate) {
        _redactEnemyRow(row);
      } else {
        row.showHP = owned || !!playerCfg.showHP;
        row.showTempHP = owned || !!playerCfg.showTempHP;
        row.showResources = owned || !!playerCfg.showResources;
        row.showSpellSlots = owned;
        row.showStatuses = owned || !!playerCfg.showStatuses;
        row.showQuickTraits = owned || !!playerCfg.showQuickTraits;
        row.showWeaknesses = owned || !!playerCfg.showWeaknesses;
        row.showWeaknessDetails = owned;
        row.showDeath = owned && !!row.death?.visible;
      }
      row.isOwnedByUser = owned;
      row.pendingInitiative = !row.hasInitiative;
      row.canRollInitiative = row.isOwnedByUser && !row.hasInitiative;
      out.push(row);
    }
    return out;
  }

  async getData() {
    const rows = this._getRows();
    const publicMeta = this.publicState?.combatMeta || {};
    const meta = _buildCombatMetaLocal(rows, publicMeta);
    return {
      hasScene: !!canvas?.scene,
      sceneName: this.publicState?.sceneName || canvas?.scene?.name || 'Escena actual',
      rows,
      combatMeta: meta,
      visibleSummary: `${rows.length} visibles`,
      gmHandledName: null,
      isCombatMode: true,
      isCombatVertical: this.combatOrientation === 'vertical',
      playerWindow: true
    };
  }

  async _render(force = false, options = {}) {
    const st = this.state || {};
    if (!Number.isFinite(options.left) && Number.isFinite(st.left)) options.left = st.left;
    if (!Number.isFinite(options.top) && Number.isFinite(st.top)) options.top = st.top;
    if (!Number.isFinite(options.width) && Number.isFinite(st.width)) options.width = st.width;
    if (!Number.isFinite(options.height) && Number.isFinite(st.height)) options.height = st.height;
    const out = await super._render(force, options);
    this._registerHooks();
    return out;
  }


  setPosition(position = {}) {
    const out = super.setPosition(position);
    this._scheduleStateSave();
    return out;
  }

  _scheduleStateSave() {
    clearTimeout(this._stateSaveTimer);
    this._stateSaveTimer = setTimeout(() => {
      this._saveState?.();
    }, 140);
  }

  _enableWholeWindowDrag(html) {
    const root = html.closest('.window-app');
    if (!root?.length) return;
    const rootEl = root[0];
    const ignoreSelector = 'button, input, select, textarea, a, label, [data-action], .ol-scene-close-btn, .ol-context-menu, .ol-context-menu *';
    root.off('.olWindowDrag');

    root.on('mousedown.olWindowDrag', (ev) => {
      if (ev.button !== 0) return;
      if (ev.target?.closest?.(ignoreSelector)) return;
      const startLeft = Number.isFinite(Number(this.position?.left)) ? Number(this.position.left) : (Number.isFinite(Number(rootEl.offsetLeft)) ? Number(rootEl.offsetLeft) : 0);
      const startTop = Number.isFinite(Number(this.position?.top)) ? Number(this.position.top) : (Number.isFinite(Number(rootEl.offsetTop)) ? Number(rootEl.offsetTop) : 0);
      const startX = ev.clientX;
      const startY = ev.clientY;
      let moved = false;
      const onMove = (moveEv) => {
        const dx = moveEv.clientX - startX;
        const dy = moveEv.clientY - startY;
        if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        moved = true;
        this.setPosition({ left: startLeft + dx, top: startTop + dy });
      };
      const onUp = async () => {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        document.body.classList.remove('ol-window-dragging');
        if (moved) {
          this._dragJustHappened = Date.now();
          try { await this._saveState?.(); } catch (_) {}
          try { await this._persistState?.(); } catch (_) {}
        }
      };
      document.body.classList.add('ol-window-dragging');
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    });

    root.on('click.olWindowDrag', (ev) => {
      if (!this._dragJustHappened) return;
      if ((Date.now() - this._dragJustHappened) > 180) {
        this._dragJustHappened = 0;
        return;
      }
      ev.preventDefault();
      ev.stopImmediatePropagation();
      this._dragJustHappened = 0;
    });
  }

  activateListeners(html) {
    super.activateListeners(html);
    this._enableWholeWindowDrag(html);
    html.on('click', '[data-action="close-monitor"]', async (ev) => { ev.preventDefault(); await this.close(); });
    html.on('click', '[data-action="refresh"]', async (ev) => { ev.preventDefault(); this.render(true); });
    html.on('click', '[data-action="open-player-config"]', async (ev) => { ev.preventDefault(); await this._openConfig(); });
    html.on('click', '[data-action="roll-my-initiative"]', async (ev) => { ev.preventDefault(); await this._rollMyInitiative(); });
    html.on('click', '[data-action="roll-initiative-one"]', async (ev) => { ev.preventDefault(); ev.stopPropagation(); const tokenId = String(ev.currentTarget.dataset.tokenId || ''); if (tokenId) await this._requestInitiativeRoll([tokenId]); });
    html.on('dblclick', '.ol-scene-card[data-token-id]', async (ev) => {
      if ($(ev.target).closest('button, input, select, textarea, a, [data-action], .ol-context-menu, .ol-context-menu *').length) return;
      ev.preventDefault();
      ev.stopPropagation();
      const tokenId = String(ev.currentTarget?.dataset?.tokenId || '');
      const token = this._getTokenById(tokenId);
      if (!token?.actor || !_isOwnedByCurrentUser(token.actor)) return;
      try { game.olAttack?.open?.({ actor: token.actor, token }); }
      catch (err) { console.warn('[ol-attack] No se pudo abrir la macro desde el monitor de jugador', err); }
    });

    html.on('contextmenu', '.ol-scene-card[data-token-id]', async (ev) => {
      const ignore = ev.target?.closest?.('button, input, select, textarea, a, [data-action], .ol-context-menu, .ol-context-menu *');
      if (ignore) return;
      ev.preventDefault();
      ev.stopPropagation();
      const tokenId = String(ev.currentTarget?.dataset?.tokenId || '');
      if (!tokenId) return;
      await this._openTokenContextMenu(tokenId, { x: ev.clientX, y: ev.clientY });
    });
  }

  async _openTokenContextMenu(tokenId, point = {}) {
    const token = this._getTokenById(tokenId);
    if (!token?.actor) return;
    const isTargeted = Array.from(game.user?.targets || []).some((t) => String(t.id) === String(tokenId));
    const owned = _isOwnedByCurrentUser(token.actor);
    const combat = game.combats?.find?.((c) => String(c.scene?.id || c.scene) === String(canvas?.scene?.id || '')) || null;
    const combatant = Array.from(combat?.combatants || []).find((c) => String(c.tokenId) === String(tokenId));
    const hasInitiative = combatant?.initiative !== null && combatant?.initiative !== undefined;
    closeOlContextMenu();
    openOlContextMenu({
      x: safeNum(point.x, window.innerWidth / 2),
      y: safeNum(point.y, window.innerHeight / 2),
      title: token.name || token.actor.name,
      items: [
        {
          label: isTargeted ? 'Quitar objetivo' : 'Marcar objetivo',
          action: async () => { await this._toggleTargetToken(tokenId, !isTargeted); }
        },
        ...(owned ? [{
          label: hasInitiative ? 'Iniciativa ya tirada' : 'Tirar iniciativa',
          disabled: !!hasInitiative,
          action: async () => { await this._requestInitiativeRoll([tokenId]); }
        }] : [])
      ]
    });
  }

  _getTokenById(tokenId) {
    const id = String(tokenId || '');
    return canvas?.tokens?.get?.(id) || canvas?.tokens?.placeables?.find?.((t) => String(t.id) === id) || null;
  }

  async _toggleTargetToken(tokenId, state = true) {
    const token = this._getTokenById(tokenId);
    if (!token) return;
    try {
      token.setTarget(!!state, { user: game.user, releaseOthers: !!state, groupSelection: false });
      this.render(false);
    } catch (_) {
      ui.notifications?.warn?.('No se pudo marcar el token como objetivo.');
    }
  }

  _getOwnedCombatTokenIds() {
    const ids = Array.isArray(this.publicState?.combatTokenIds) ? this.publicState.combatTokenIds.map(String) : [];
    const out = [];
    for (const tokenId of ids) {
      const token = this._getTokenById(tokenId);
      if (!token?.actor) continue;
      if (!_isOwnedByCurrentUser(token.actor)) continue;
      out.push(String(tokenId));
    }
    return out;
  }

  async _requestInitiativeRoll(tokenIds = []) {
    const validIds = Array.from(new Set((tokenIds || []).map(String))).filter(Boolean);
    if (!validIds.length) {
      ui.notifications?.warn?.('No tienes personajes válidos para tirar iniciativa.');
      return;
    }
    try {
      game.socket?.emit?.(SOCKET_NS, {
        type: 'playerRollInitiative',
        userId: game.user?.id,
        sceneId: canvas?.scene?.id || null,
        tokenIds: validIds
      });
      ui.notifications?.info?.(validIds.length > 1 ? 'Petición de iniciativa enviada al GM.' : 'Petición de iniciativa enviada.');
    } catch (_) {
      ui.notifications?.warn?.('No se pudo solicitar la tirada de iniciativa.');
    }
  }

  async _rollMyInitiative() {
    const ids = this._getOwnedCombatTokenIds();
    if (!ids.length) {
      ui.notifications?.warn?.('No controlas ningún participante visible en este combate.');
      return;
    }
    const combat = game.combats?.find?.((c) => String(c.scene?.id || c.scene) === String(canvas?.scene?.id || '')) || null;
    const pendingIds = ids.filter((tokenId) => {
      const combatant = Array.from(combat?.combatants || []).find((c) => String(c.tokenId) === String(tokenId));
      return combatant && (combatant.initiative === null || combatant.initiative === undefined);
    });
    if (!pendingIds.length) {
      ui.notifications?.info?.('Tu iniciativa ya está tirada.');
      return;
    }
    await this._requestInitiativeRoll(pendingIds);
  }

  async _openConfig() {
    return await new Promise((resolve) => {
      new LegacyDialog({
        title: 'Configurar monitor resumido',
        content: `
          <div class="ol-visual-conf embedded">
            <label class="ol-visual-conf-row">
              <span>Orientación</span>
              <select name="combatOrientation">
                <option value="horizontal" ${this.combatOrientation === 'horizontal' ? 'selected' : ''}>Horizontal</option>
                <option value="vertical" ${this.combatOrientation === 'vertical' ? 'selected' : ''}>Vertical</option>
              </select>
              <b>${this.combatOrientation === 'vertical' ? 'Columna' : 'Fila'}</b>
            </label>
            <p class="ol-monitor-conf-hint">Como jugador o jugadora, aquí solo puedes cambiar la orientación de la distribución.</p>
          </div>`,
        buttons: {
          save: { label: 'Guardar', callback: async (dlg) => {
            this.combatOrientation = ['horizontal', 'vertical'].includes(String(dlg.find('select[name="combatOrientation"]').val() || 'horizontal')) ? String(dlg.find('select[name="combatOrientation"]').val() || 'horizontal') : 'horizontal';
            await this._saveState();
            this.render(true);
            resolve(true);
          } },
          cancel: { label: game.i18n.localize('Cancel'), callback: () => resolve(null) }
        },
        default: 'save'
      }, { width: 420 }).render(true);
    });
  }

  _registerHooks() {
    if (this._hookIds.length) return;
    const rerender = () => { if (this.rendered) this.render(false); };
    const on = (hook) => this._hookIds.push([hook, Hooks.on(hook, rerender)]);
    ['updateActor', 'updateItem', 'createItem', 'deleteItem', 'updateActiveEffect', 'createActiveEffect', 'deleteActiveEffect', 'updateToken', 'canvasReady', 'updateCombat', 'combatTurn', 'combatRound', 'combatStart', 'createCombat', 'deleteCombat', 'createCombatant', 'deleteCombatant', 'updateCombatant', 'targetToken'].forEach(on);
  }

  async close(options = {}) {
    clearTimeout(this._stateSaveTimer);
    closeOlContextMenu();
    await this._saveState();
    for (const [hook, id] of this._hookIds) Hooks.off(hook, id);
    this._hookIds = [];
    return super.close(options);
  }
}
