import { gp, safeNum } from "../lib/utils.js";
import { MODULE_ID, FLAG_SCOPE, FLAG_CONCENTRATION, SETTING_SCENE_TRACKER_WINDOW_STATE, SETTING_PLAYER_SCENE_PUBLIC_STATE, SOCKET_NS } from "../shared/constants.js";
import { LegacyApplication, LegacyDialog } from "../shared/compat.js";
import { getItemUses } from "../lib/uses.js";
import { openStatusPicker } from "../lib/statuses.js";
import { openOlContextMenu, closeOlContextMenu } from "../lib/context-menu.js";
import { getActorHpData, updateActorHpData, getActorDeathSaveData, getActorTraits } from "../shared/system-data.js";
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

function _norm(value) {
  return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function _mixHex(a, b, t) {
  const pa = a.replace('#', '');
  const pb = b.replace('#', '');
  const ar = parseInt(pa.slice(0, 2), 16);
  const ag = parseInt(pa.slice(2, 4), 16);
  const ab = parseInt(pa.slice(4, 6), 16);
  const br = parseInt(pb.slice(0, 2), 16);
  const bg = parseInt(pb.slice(2, 4), 16);
  const bb = parseInt(pb.slice(4, 6), 16);
  const lerp = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${lerp(ar, br)}, ${lerp(ag, bg)}, ${lerp(ab, bb)})`;
}

function _hpColorByRatio(ratio) {
  const r = _clamp(Number(ratio) || 0, 0, 1);
  if (r >= 0.5) {
    const t = (r - 0.5) / 0.5;
    return _mixHex('#d97706', '#1f9d55', t);
  }
  if (r >= 0.25) {
    const t = (r - 0.25) / 0.25;
    return _mixHex('#b91c1c', '#d97706', t);
  }
  const t = r / 0.25;
  return _mixHex('#050505', '#b91c1c', t);
}

function _getHpDisplay(hp = {}) {
  const value = Math.max(0, safeNum(hp.value, 0));
  const max = Math.max(0, safeNum(hp.max, 0));
  const temp = Math.max(0, safeNum(hp.temp, 0));
  const ratio = max > 0 ? _clamp(value / max, 0, 1) : 0;
  const width = `${Math.round(ratio * 1000) / 10}%`;
  return {
    value,
    max,
    temp,
    ratio,
    fillStyle: `width:${width}; background:${_hpColorByRatio(ratio)};`,
    tempFillStyle: temp > 0 ? 'width:100%; background:rgba(31,157,85,.9);' : 'width:0%; background:transparent;',
    tempActive: temp > 0
  };
}

function _getDeathSaveDisplay(actor, hp = {}) {
  const death = getActorDeathSaveData(actor);
  const successes = _clamp(safeNum(death.success, 0), 0, 3);
  const failures = _clamp(safeNum(death.failure, 0), 0, 3);
  const value = safeNum(hp.value, 0);
  const visible = value <= 0 || successes > 0 || failures > 0;
  return {
    visible,
    successes,
    failures,
    successDots: Array.from({ length: 3 }, (_, i) => ({ filled: i < successes, idx: i + 1 })),
    failureDots: Array.from({ length: 3 }, (_, i) => ({ filled: i < failures, idx: i + 1 })),
    stateLabel: failures >= 3 ? 'Muerto' : (successes >= 3 ? 'Estable' : 'En riesgo')
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
      const origin = _norm(effect.origin || gp(effect, 'flags.dnd5e.origin') || '');
      const desc = _norm(gp(effect, 'description') || gp(effect, 'changes') || '');
      const dnd5eConcentration = gp(effect, 'flags.dnd5e.concentration') || gp(effect, 'flags.dnd5e.isConcentration');
      return (
        label.includes('concentr') ||
        icon.includes('concentr') ||
        origin.includes('concentr') ||
        desc.includes('concentr') ||
        dnd5eConcentration === true ||
        statuses.some((s) => s.includes('concentr'))
      );
    });
    if (effectHit) return true;
  } catch (_) {}

  try {
    const statuses = actor?.statuses;
    if (statuses?.has?.('concentrating') || statuses?.has?.('concentration')) return true;
    for (const s of Array.from(statuses || [])) {
      if (_norm(s).includes('concentr')) return true;
    }
  } catch (_) {}

  try {
    const ownFlag = gp(actor, `flags.${FLAG_SCOPE}.${FLAG_CONCENTRATION}`) || gp(actor, `flags.world.${FLAG_CONCENTRATION}`);
    if (ownFlag && (ownFlag.name || ownFlag.active || typeof ownFlag === 'string')) return true;
  } catch (_) {}

  try {
    const items = actor?.items?.contents || actor?.items || [];
    for (const item of Array.from(items)) {
      if (!item) continue;
      const active = gp(item, 'system.active') === true || gp(item, 'system.equipped') === true;
      const props = gp(item, 'system.properties') || gp(item, 'system.spellProperties') || [];
      const hasProp = Array.isArray(props) && props.some((p) => _norm(p).includes('concentr'));
      const hasDur = gp(item, 'system.duration.concentration') === true || _norm(gp(item, 'system.duration.units') || '').includes('concentr');
      if (active && (hasProp || hasDur)) return true;
    }
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
  if (_hasConcentration(actor)) {
    out.push({ id: 'concentration', label: 'Concentración', shortLabel: 'Conc.', tone: 'magic', hint: 'Tiene un efecto de concentración activo.' });
  }
  if (_hasNamedFeature(actor, ['multiattack', 'multiataque', 'ataque multiple', 'ataque múltiple'])) {
    out.push({ id: 'multiattack', label: 'Multiataque', shortLabel: 'Multiat.', tone: 'feature', hint: 'Dispone de un rasgo o acción tipo Multiataque.' });
  }
  if (_hasNamedFeature(actor, ['legendary resistance', 'resistencia legendaria'])) {
    out.push({ id: 'legendary-resistance', label: 'Resistencia legendaria', shortLabel: 'RL', tone: 'feature', hint: 'Tiene al menos una resistencia legendaria.' });
  }
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
  return out.filter((s) => {
    const key = `${s.label}__${s.icon}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function _collectResources(actor) {
  const items = actor?.items?.contents || actor?.items || [];
  const out = [];
  for (const item of items) {
    const uses = getItemUses(item);
    if (uses.max <= 0) continue;
    const type = String(item?.type || "");
    const include = ["spell", "feat", "class", "consumable"].includes(type) || _resourcePriority(item) < 100;
    if (!include) continue;
    out.push({
      id: item.id,
      name: item.name,
      shortName: item.name,
      remaining: uses.remaining,
      max: uses.max,
      priority: _resourcePriority(item),
      depleted: uses.remaining <= 0
    });
  }
  out.sort((a, b) => Number(a.depleted) - Number(b.depleted) || a.priority - b.priority || a.name.localeCompare(b.name, "es"));
  return out;
}


function _isVideoPath(src) {
  const value = String(src || '').trim().toLowerCase();
  return value.endsWith('.webm') || value.endsWith('.mp4') || value.endsWith('.m4v') || value.endsWith('.mov');
}

function _isGenericPortrait(src) {
  const value = _norm(src || '');
  return !value || value.includes('icons/svg/mystery-man.svg') || value.includes('icons/svg/hazard.svg');
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

function _imageModeLabel(mode, actor, token) {
  const labels = {
    auto: 'Auto',
    actor: 'Retrato del actor',
    token: 'Imagen del token',
    prototype: 'Imagen del prototipo',
    custom: 'Archivo / URL personalizada'
  };
  const normalized = String(mode || 'auto');
  if (normalized === 'auto') {
    const actorImg = String(actor?.img || '').trim();
    return _isGenericPortrait(actorImg) ? 'Auto · usa token' : 'Auto · usa actor';
  }
  return labels[normalized] || 'Auto';
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

function _buildRow(token, extra = {}) {
  const actor = token?.actor;
  const hp = _getHpDisplay(getActorHpData(actor));

  const death = _getDeathSaveDisplay(actor, hp);
  const hasInitiative = Number.isFinite(Number(extra.initiative));
  const portraits = _pickPortraits(actor, token, extra.imageChoice || {});
  const targetedTokenId = String(extra.targetedTokenId || '');
  const bgMedia = String(portraits.portrait || portraits.avatar || '').trim();
  const bgMediaIsVideo = _isVideoPath(bgMedia);
  return {
    tokenId: token.id,
    tokenName: token.name || actor?.name,
    actorId: actor?.id,
    actorName: actor?.name,
    img: portraits.avatar,
    actorImg: portraits.portrait,
    bgMedia,
    bgMediaIsVideo,
    isPC: !!actor?.hasPlayerOwner,
    hidden: !!token.document?.hidden,
    hp,
    death,
    resources: _collectResources(actor),
    statuses: _collectStatuses(actor),
    quickTraits: _collectQuickTraits(actor),
    weaknesses: _collectWeaknessSummary(actor),
    initiative: hasInitiative ? Number(extra.initiative) : null,
    initiativeLabel: hasInitiative ? Number(extra.initiative) : 'Sin tirar',
    hasInitiative,
    turnIndex: Number.isFinite(Number(extra.turnIndex)) ? Number(extra.turnIndex) : null,
    inCombat: !!extra.inCombat,
    isActiveTurn: !!extra.isActiveTurn,
    pendingInitiative: !!extra.pendingInitiative,
    selectionVisible: !!extra.selectionVisible,
    selectionCombat: !!extra.selectionCombat,
    isGmHandled: !!extra.isGmHandled,
    isTargetedByUser: !!targetedTokenId && targetedTokenId === String(token.id)
  };
}

function _sortTokensByName(tokens = []) {
  return Array.from(tokens).sort((a, b) => String(a?.name || a?.actor?.name || '').localeCompare(String(b?.name || b?.actor?.name || ''), 'es'));
}

function _defaultVisualSettings() {
  return {
    usePortraitBackground: true,
    backgroundOpacity: 40,
    overlayOpacity: 60,
    backgroundSize: 'cover'
  };
}

function _defaultPlayerViewConfig() {
  return {
    showPCs: true,
    showNPCs: true,
    showHP: true,
    showTempHP: true,
    showResources: false,
    showStatuses: true,
    showQuickTraits: true,
    showWeaknesses: false
  };
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
  const vuln = _normalizeTraitEntries(traits.dv, traits.dv?.custom);
  const resist = _normalizeTraitEntries(traits.dr, traits.dr?.custom);
  const immune = _normalizeTraitEntries(traits.di, traits.di?.custom);
  return {
    vulnerability: vuln,
    resistance: resist,
    immunity: immune,
    hasAny: !!(vuln.length || resist.length || immune.length)
  };
}

class OLSceneTrackerConfigApp extends LegacyApplication {
  constructor(tracker, options = {}) {
    super(options);
    this.tracker = tracker;
    this.focusVisual = !!options.focusVisual;
    this._resolver = null;
    this._resolved = false;
    const pos = foundry.utils.deepClone(tracker?.state?.configWindowState || {});
    this._initialPosition = {
      left: Number.isFinite(Number(pos.left)) ? Number(pos.left) : null,
      top: Number.isFinite(Number(pos.top)) ? Number(pos.top) : null,
      width: Number.isFinite(Number(pos.width)) ? Number(pos.width) : 1460,
      height: Number.isFinite(Number(pos.height)) ? Number(pos.height) : 900
    };
    this.draft = this._buildDraft(options.selectedTokenId || '');
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'ol-scene-tracker-config-app',
      title: 'Configurar monitor de escena',
      template: 'modules/ol-attack/templates/scene-tracker-config-app.hbs',
      classes: ['ol-attack', 'ol-window-theme', 'ol-scene-tracker', 'ol-scene-config-app'],
      width: 1460,
      height: 900,
      minWidth: 900,
      minHeight: 620,
      resizable: true,
      minimizable: true,
      popOut: true
    });
  }

  get title() {
    return this.focusVisual ? 'Configurar monitor de escena · Visual' : 'Configurar monitor de escena';
  }

  _getTokens() {
    return this.tracker?._getSceneTokens?.() || [];
  }

  _buildDraft(selectedTokenId = '') {
    const tokens = this._getTokens();
    const visuals = this.tracker?._getVisualSettings?.() || _defaultVisualSettings();
    const tokenIds = tokens.map((t) => String(t.id));
    const visibleIds = new Set((this.tracker?.visibleTokenIds?.length ? this.tracker.visibleTokenIds : tokenIds).map(String));
    const combatIds = new Set((this.tracker?.combatTokenIds || []).map(String));
    const visibleById = Object.fromEntries(tokenIds.map((id) => [id, visibleIds.has(id)]));
    const combatById = Object.fromEntries(tokenIds.map((id) => [id, combatIds.has(id)]));
    const opacityById = Object.fromEntries(tokenIds.map((id) => [id, this.tracker?._getPerTokenOpacity?.(id, visuals) ?? Number(visuals.backgroundOpacity || 40)]));
    const imageChoiceById = Object.fromEntries(tokenIds.map((id) => [id, this.tracker?._getPerTokenImageChoice?.(id) || { mode: 'auto', custom: '' }]));
    return {
      tokenIds,
      selectedTokenId: String(selectedTokenId || tokenIds[0] || ''),
      filterTerm: '',
      kindFilter: 'all',
      visibleById,
      combatById,
      opacityById,
      imageChoiceById,
      visualSettings: foundry.utils.mergeObject(_defaultVisualSettings(), foundry.utils.deepClone(visuals || {})),
      combatOrientation: ['horizontal', 'vertical'].includes(String(this.tracker?.combatOrientation || 'horizontal')) ? String(this.tracker?.combatOrientation || 'horizontal') : 'horizontal',
      playerViewConfig: foundry.utils.mergeObject(_defaultPlayerViewConfig(), foundry.utils.deepClone(this.tracker?.playerViewConfig || {}))
    };
  }

  _getTokenById(id) {
    const sid = String(id || '');
    return this._getTokens().find((t) => String(t.id) === sid) || null;
  }

  _ensureSelectedToken() {
    const tokens = this._getTokens();
    const ids = new Set(tokens.map((t) => String(t.id)));
    if (ids.has(String(this.draft.selectedTokenId || ''))) return;
    this.draft.selectedTokenId = String(tokens[0]?.id || '');
  }

  _rowData(token) {
    const actor = token?.actor;
    const id = String(token?.id || '');
    const choice = this.draft.imageChoiceById[id] || { mode: 'auto', custom: '' };
    const portraits = _pickPortraits(actor, token, choice);
    const type = actor?.hasPlayerOwner ? 'PJ' : 'PNJ';
    const sub = `${type}${token?.document?.hidden ? ' · Oculto' : ''}${_isGenericPortrait(actor?.img) ? ' · Auto usa token' : ' · Auto usa actor'}`;
    return {
      id,
      name: token?.name || actor?.name || '—',
      sub,
      avatar: portraits.avatar || portraits.portrait || 'icons/svg/mystery-man.svg',
      kind: actor?.hasPlayerOwner ? 'pc' : 'npc',
      search: _norm(`${token?.name || actor?.name || ''} ${type} ${token?.document?.hidden ? 'oculto' : ''}`),
      isSelected: String(this.draft.selectedTokenId || '') === id,
      visible: !!this.draft.visibleById[id],
      combat: !!this.draft.combatById[id]
    };
  }

  _selectedData() {
    const token = this._getTokenById(this.draft.selectedTokenId);
    if (!token?.actor) return null;
    const actor = token.actor;
    const id = String(token.id);
    const choice = this.draft.imageChoiceById[id] || { mode: 'auto', custom: '' };
    const opacity = _clamp(safeNum(this.draft.opacityById[id], Number(this.draft.visualSettings?.backgroundOpacity) || 40), 0, 100);
    const resolved = _resolvePortraitChoice(actor, token, choice);
    const mode = String(choice.mode || 'auto');
    const available = _collectAvailablePortraitOptions(actor, token);
    const modeOptions = [
      { value: 'auto', label: 'Auto', selected: mode === 'auto' },
      ...available.map((opt) => ({ value: opt.key, label: opt.label, selected: mode === String(opt.key) })),
      { value: 'custom', label: 'Archivo / URL personalizada', selected: mode === 'custom' }
    ];
    const quickButtons = [
      { value: 'auto', label: 'Auto', selected: mode === 'auto' },
      ...available.map((opt) => ({ value: opt.key, label: opt.label.replace(/^Imagen del\s+/i, '').replace(/^Retrato del\s+/i, ''), selected: mode === String(opt.key) })),
      { value: 'custom', label: 'Archivo', selected: mode === 'custom' }
    ];
    const sub = `${actor?.hasPlayerOwner ? 'PJ' : 'PNJ'}${token.document?.hidden ? ' · Oculto' : ''}${_isGenericPortrait(actor?.img) ? ' · Auto usa token' : ' · Auto usa actor'}`;
    return {
      id,
      name: token.name || actor.name || '—',
      sub,
      preview: resolved.portrait || resolved.avatar || 'icons/svg/mystery-man.svg',
      resolvedLabel: _imageModeLabel(mode, actor, token),
      opacity,
      custom: String(choice.custom || ''),
      modeOptions,
      quickButtons
    };
  }

  getData() {
    this._ensureSelectedToken();
    const rows = this._getTokens().map((token) => this._rowData(token));
    const visuals = this.draft.visualSettings || _defaultVisualSettings();
    const playerView = this.draft.playerViewConfig || _defaultPlayerViewConfig();
    return {
      rows,
      selected: this._selectedData(),
      filterTerm: String(this.draft.filterTerm || ''),
      kindAllSelected: String(this.draft.kindFilter || 'all') === 'all',
      kindPCSelected: String(this.draft.kindFilter || 'all') === 'pc',
      kindNPCSelected: String(this.draft.kindFilter || 'all') === 'npc',
      usePortraitBackground: !!visuals.usePortraitBackground,
      backgroundOpacity: Number(visuals.backgroundOpacity) || 40,
      overlayOpacity: Number(visuals.overlayOpacity) || 60,
      backgroundSizeCover: String(visuals.backgroundSize || 'cover') === 'cover',
      backgroundSizeContain: String(visuals.backgroundSize || 'cover') === 'contain',
      combatOrientationHorizontal: String(this.draft.combatOrientation || 'horizontal') === 'horizontal',
      combatOrientationVertical: String(this.draft.combatOrientation || 'horizontal') === 'vertical',
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

  async _render(force = false, options = {}) {
    const live = this.position || {};
    const base = {
      left: Number.isFinite(Number(live.left)) ? Number(live.left) : this._initialPosition.left,
      top: Number.isFinite(Number(live.top)) ? Number(live.top) : this._initialPosition.top,
      width: Number.isFinite(Number(live.width)) ? Number(live.width) : this._initialPosition.width,
      height: Number.isFinite(Number(live.height)) ? Number(live.height) : this._initialPosition.height
    };
    if (!Number.isFinite(options.left) && Number.isFinite(base.left)) options.left = base.left;
    if (!Number.isFinite(options.top) && Number.isFinite(base.top)) options.top = base.top;
    if (!Number.isFinite(options.width) && Number.isFinite(base.width)) options.width = base.width;
    if (!Number.isFinite(options.height) && Number.isFinite(base.height)) options.height = base.height;
    return super._render(force, options);
  }

  setPosition(position = {}) {
    const out = super.setPosition(position);
    clearTimeout(this._savePosTimer);
    this._savePosTimer = setTimeout(() => {
      try {
        const pos = this.position || {};
        const configWindowState = {
          left: Number.isFinite(Number(pos.left)) ? Number(pos.left) : null,
          top: Number.isFinite(Number(pos.top)) ? Number(pos.top) : null,
          width: Number.isFinite(Number(pos.width)) ? Number(pos.width) : 1460,
          height: Number.isFinite(Number(pos.height)) ? Number(pos.height) : 900
        };
        this._initialPosition = { ...configWindowState };
        this.tracker.state = {
          ...(this.tracker.state || {}),
          configWindowState
        };
        this.tracker._saveWindowState?.({ configWindowState });
      } catch (_) {}
    }, 120);
    return out;
  }

  _applyFilterVisibility(html) {
    const term = _norm(this.draft.filterTerm || '');
    const kind = String(this.draft.kindFilter || 'all');
    html.find('.ol-scene-config-row').each((_, el) => {
      const row = $(el);
      const rowKind = String(row.data('kind') || '');
      const search = String(row.data('search') || '');
      const okKind = kind === 'all' || rowKind === kind;
      const okText = !term || search.includes(term);
      row.toggle(okKind && okText);
    });
  }

  _selectedInputTid() {
    return String(this.draft.selectedTokenId || '');
  }

  _startWindowDrag(ev) {
    if (ev.button !== 0) return;
    if ($(ev.target).closest('button, input, select, textarea, label, a, .window-control').length) return;
    ev.preventDefault();
    ev.stopPropagation();
    const startMouseX = Number(ev.clientX) || 0;
    const startMouseY = Number(ev.clientY) || 0;
    const pos = this.position || {};
    const startLeft = Number.isFinite(Number(pos.left)) ? Number(pos.left) : 0;
    const startTop = Number.isFinite(Number(pos.top)) ? Number(pos.top) : 0;
    const width = Number.isFinite(Number(pos.width)) ? Number(pos.width) : this._initialPosition.width;
    const height = Number.isFinite(Number(pos.height)) ? Number(pos.height) : this._initialPosition.height;
    const onMove = (moveEv) => {
      const dx = (Number(moveEv.clientX) || 0) - startMouseX;
      const dy = (Number(moveEv.clientY) || 0) - startMouseY;
      this.setPosition({ left: startLeft + dx, top: startTop + dy, width, height });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp, true);
      document.body.classList.remove('ol-window-dragging');
    };
    document.body.classList.add('ol-window-dragging');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, true);
  }

  _setSelectedToken(id) {
    this.draft.selectedTokenId = String(id || '');
    this.render(false);
  }

  _updateGeneralDraftFromDom(html) {
    this.draft.visualSettings = foundry.utils.mergeObject(_defaultVisualSettings(), {
      usePortraitBackground: !!html.find('input[name="usePortraitBackground"]').prop('checked'),
      backgroundOpacity: _clamp(safeNum(html.find('input[name="backgroundOpacity"]').val(), 40), 0, 100),
      overlayOpacity: _clamp(safeNum(html.find('input[name="overlayOpacity"]').val(), 60), 20, 90),
      backgroundSize: String(html.find('select[name="backgroundSize"]').val() || 'cover')
    });
    this.draft.combatOrientation = ['horizontal', 'vertical'].includes(String(html.find('select[name="combatOrientation"]').val() || 'horizontal')) ? String(html.find('select[name="combatOrientation"]').val() || 'horizontal') : 'horizontal';
    this.draft.playerViewConfig = foundry.utils.mergeObject(_defaultPlayerViewConfig(), {
      showPCs: !!html.find('input[name="playerShowPCs"]').prop('checked'),
      showNPCs: !!html.find('input[name="playerShowNPCs"]').prop('checked'),
      showHP: !!html.find('input[name="playerShowHP"]').prop('checked'),
      showTempHP: !!html.find('input[name="playerShowTempHP"]').prop('checked'),
      showResources: !!html.find('input[name="playerShowResources"]').prop('checked'),
      showStatuses: !!html.find('input[name="playerShowStatuses"]').prop('checked'),
      showQuickTraits: !!html.find('input[name="playerShowQuickTraits"]').prop('checked'),
      showWeaknesses: !!html.find('input[name="playerShowWeaknesses"]').prop('checked')
    });
  }

  activateListeners(html) {
    super.activateListeners?.(html);
    this._applyFilterVisibility(html);

    html.on('mousedown', '.ol-scene-config-section-head', (ev) => this._startWindowDrag(ev));

    html.on('input', '[data-role="tokenFilter"]', (ev) => {
      this.draft.filterTerm = String(ev.currentTarget.value || '');
      this._applyFilterVisibility(html);
    });

    html.on('click', '[data-role="kindFilter"]', (ev) => {
      ev.preventDefault();
      this.draft.kindFilter = String(ev.currentTarget.dataset.kind || 'all');
      html.find('[data-role="kindFilter"]').removeClass('selected');
      $(ev.currentTarget).addClass('selected');
      this._applyFilterVisibility(html);
    });

    html.on('click', '[data-role="selectToken"]', (ev) => {
      ev.preventDefault();
      const tid = String($(ev.currentTarget).closest('.ol-scene-config-row').data('tokenId') || ev.currentTarget.dataset.tokenId || '');
      if (!tid) return;
      this._updateGeneralDraftFromDom(html);
      this._setSelectedToken(tid);
    });

    html.on('change', 'input[data-role="visible"]', (ev) => {
      const tid = String(ev.currentTarget.dataset.tokenId || '');
      this.draft.visibleById[tid] = !!ev.currentTarget.checked;
      if (!ev.currentTarget.checked) {
        this.draft.combatById[tid] = false;
        html.find(`input[data-role="combat"][data-token-id="${tid}"]`).prop('checked', false);
      }
    });

    html.on('change', 'input[data-role="combat"]', (ev) => {
      const tid = String(ev.currentTarget.dataset.tokenId || '');
      this.draft.combatById[tid] = !!ev.currentTarget.checked;
      if (ev.currentTarget.checked) {
        this.draft.visibleById[tid] = true;
        html.find(`input[data-role="visible"][data-token-id="${tid}"]`).prop('checked', true);
      }
    });

    const bulkOnFiltered = (updater) => {
      html.find('.ol-scene-config-row:visible').each((_, el) => updater($(el)));
    };
    html.on('click', '[data-role="bulkVisibleFiltered"]', (ev) => {
      ev.preventDefault();
      bulkOnFiltered((row) => {
        const tid = String(row.data('tokenId') || '');
        this.draft.visibleById[tid] = true;
        row.find('input[data-role="visible"]').prop('checked', true);
      });
    });
    html.on('click', '[data-role="bulkCombatFiltered"]', (ev) => {
      ev.preventDefault();
      bulkOnFiltered((row) => {
        const tid = String(row.data('tokenId') || '');
        this.draft.visibleById[tid] = true;
        this.draft.combatById[tid] = true;
        row.find('input[data-role="visible"]').prop('checked', true);
        row.find('input[data-role="combat"]').prop('checked', true);
      });
    });
    html.on('click', '[data-role="bulkClearFiltered"]', (ev) => {
      ev.preventDefault();
      bulkOnFiltered((row) => {
        const tid = String(row.data('tokenId') || '');
        this.draft.visibleById[tid] = false;
        this.draft.combatById[tid] = false;
        row.find('input[data-role="visible"]').prop('checked', false);
        row.find('input[data-role="combat"]').prop('checked', false);
      });
    });

    html.on('change', '[data-role="inspectorImageMode"]', (ev) => {
      const tid = this._selectedInputTid();
      this.draft.imageChoiceById[tid] = {
        ...(this.draft.imageChoiceById[tid] || {}),
        mode: String(ev.currentTarget.value || 'auto')
      };
      this._updateGeneralDraftFromDom(html);
      this.render(false);
    });

    html.on('click', '[data-role="inspectorQuick"]', (ev) => {
      ev.preventDefault();
      const tid = this._selectedInputTid();
      this.draft.imageChoiceById[tid] = {
        ...(this.draft.imageChoiceById[tid] || {}),
        mode: String(ev.currentTarget.dataset.mode || 'auto')
      };
      this._updateGeneralDraftFromDom(html);
      this.render(false);
    });

    html.on('input change', '[data-role="inspectorImageCustom"]', (ev) => {
      const tid = this._selectedInputTid();
      const value = String(ev.currentTarget.value || '');
      this.draft.imageChoiceById[tid] = {
        ...(this.draft.imageChoiceById[tid] || {}),
        mode: value.trim() ? 'custom' : String(this.draft.imageChoiceById[tid]?.mode || 'auto'),
        custom: value
      };
    });

    html.on('input change', '[data-role="inspectorOpacity"]', (ev) => {
      const tid = this._selectedInputTid();
      const value = _clamp(safeNum(ev.currentTarget.value, 40), 0, 100);
      this.draft.opacityById[tid] = value;
      html.find('[data-role="inspectorOpacityValue"]').text(`${value}%`);
    });

    html.on('click', '[data-role="inspectorImageBrowse"]', async (ev) => {
      ev.preventDefault();
      const tid = this._selectedInputTid();
      if (!tid) return;
      const current = String(this.draft.imageChoiceById[tid]?.custom || '').trim();
      const picker = new FilePicker({
        type: 'imagevideo',
        current: current || 'data',
        callback: (path) => {
          this.draft.imageChoiceById[tid] = {
            ...(this.draft.imageChoiceById[tid] || {}),
            mode: 'custom',
            custom: path || ''
          };
          this._updateGeneralDraftFromDom(html);
          this.render(false);
        }
      });
      picker.render(true);
    });

    html.on('input change', 'input[name="backgroundOpacity"]', (ev) => {
      html.find('[data-role="backgroundOpacityValue"]').text(`${ev.currentTarget.value}%`);
    });
    html.on('input change', 'input[name="overlayOpacity"]', (ev) => {
      html.find('[data-role="overlayOpacityValue"]').text(`${ev.currentTarget.value}%`);
    });

    html.on('click', '[data-action="reset-defaults"]', (ev) => {
      ev.preventDefault();
      this.draft = this._buildDraft(this._selectedInputTid());
      this.render(false);
    });
    html.on('click', '[data-action="show-all"]', (ev) => {
      ev.preventDefault();
      Object.keys(this.draft.visibleById || {}).forEach((id) => { this.draft.visibleById[id] = true; });
      Object.keys(this.draft.combatById || {}).forEach((id) => { this.draft.combatById[id] = false; });
      this.render(false);
    });
    html.on('click', '[data-action="cancel"]', (ev) => {
      ev.preventDefault();
      this.close();
    });
    html.on('click', '[data-action="save"]', async (ev) => {
      ev.preventDefault();
      await this._saveAndClose(html);
    });
  }

  async _saveAndClose(html) {
    this._updateGeneralDraftFromDom(html);
    const tokens = this._getTokens();
    const tokenIds = tokens.map((t) => String(t.id));
    const visible = tokenIds.filter((id) => !!this.draft.visibleById[id]);
    const combat = tokenIds.filter((id) => !!this.draft.combatById[id]);
    this.tracker.visibleTokenIds = visible.length === tokenIds.length ? [] : visible;
    this.tracker.combatTokenIds = combat;
    this.tracker.visualSettings = foundry.utils.mergeObject(_defaultVisualSettings(), foundry.utils.deepClone(this.draft.visualSettings || {}));
    this.tracker.visualTokenOpacity = foundry.utils.deepClone(this.draft.opacityById || {});
    this.tracker.visualTokenImageChoice = foundry.utils.deepClone(this.draft.imageChoiceById || {});
    this.tracker.combatOrientation = ['horizontal', 'vertical'].includes(String(this.draft.combatOrientation || 'horizontal')) ? String(this.draft.combatOrientation || 'horizontal') : 'horizontal';
    this.tracker.playerViewConfig = foundry.utils.mergeObject(_defaultPlayerViewConfig(), foundry.utils.deepClone(this.draft.playerViewConfig || {}));
    try {
      const pos = this.position || {};
      this.tracker.state = {
        ...(this.tracker.state || {}),
        configWindowState: {
          left: Number.isFinite(Number(pos.left)) ? Number(pos.left) : null,
          top: Number.isFinite(Number(pos.top)) ? Number(pos.top) : null,
          width: Number.isFinite(Number(pos.width)) ? Number(pos.width) : 1460,
          height: Number.isFinite(Number(pos.height)) ? Number(pos.height) : 900
        }
      };
    } catch (_) {}
    await this.tracker._persistState?.();
    this.tracker.render(true);
    const result = {
      visible: this.tracker.visibleTokenIds,
      combat: this.tracker.combatTokenIds,
      visualSettings: this.tracker.visualSettings,
      visualTokenOpacity: this.tracker.visualTokenOpacity,
      visualTokenImageChoice: this.tracker.visualTokenImageChoice,
      combatOrientation: this.tracker.combatOrientation,
      playerViewConfig: this.tracker.playerViewConfig
    };
    this._resolved = true;
    if (this._resolver) this._resolver(result);
    return this.close();
  }

  waitForClose() {
    return new Promise((resolve) => {
      this._resolver = resolve;
    });
  }

  async close(options = {}) {
    if (!this._resolved && this._resolver) {
      this._resolver(null);
      this._resolver = null;
    }
    return super.close(options);
  }
}


export class OLSceneTrackerApp extends LegacyApplication {
  constructor(options = {}) {
    super(options);
    this._hookIds = [];
    this.state = this._loadWindowState();
    this.displayMode = String(options.displayMode || this.state.displayMode || 'overview');
    this.visibleTokenIds = Array.isArray(options.visibleTokenIds) ? options.visibleTokenIds.map(String) : Array.isArray(this.state.visibleTokenIds) ? this.state.visibleTokenIds.map(String) : [];
    this.combatTokenIds = Array.isArray(options.combatTokenIds) ? options.combatTokenIds.map(String) : Array.isArray(this.state.combatTokenIds) ? this.state.combatTokenIds.map(String) : [];
    this.visualSettings = foundry.utils.mergeObject(_defaultVisualSettings(), foundry.utils.deepClone(options.visualSettings || this.state.visualSettings || {}));
    this.visualTokenOpacity = foundry.utils.deepClone(options.visualTokenOpacity || this.state.visualTokenOpacity || {});
    this.visualTokenImageChoice = foundry.utils.deepClone(options.visualTokenImageChoice || this.state.visualTokenImageChoice || {});
    this.combatOrientation = ['horizontal', 'vertical'].includes(String(options.combatOrientation || this.state.combatOrientation || 'horizontal')) ? String(options.combatOrientation || this.state.combatOrientation || 'horizontal') : 'horizontal';
    this.playerViewConfig = foundry.utils.mergeObject(_defaultPlayerViewConfig(), foundry.utils.deepClone(options.playerViewConfig || this.state.playerViewConfig || {}));
    this.gmHandledTokenId = String(options.gmHandledTokenId || this.state.gmHandledTokenId || game.olAttack?.getHandledToken?.()?.id || '');
    if (this.gmHandledTokenId) game.olAttack?.setHandledToken?.(this.gmHandledTokenId);
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'ol-scene-tracker-app',
      title: 'OL Monitor de Escena',
      template: 'modules/ol-attack/templates/scene-tracker-app.hbs',
      classes: ['ol-attack', 'ol-window-theme', 'ol-scene-tracker'],
      width: 980,
      height: 720,
      minWidth: 760,
      minHeight: 520,
      resizable: true,
      minimizable: true
    });
  }


  _loadWindowState() {
    const fallback = {
      left: null,
      top: null,
      width: 980,
      height: 720,
      displayMode: 'overview',
      visibleTokenIds: [],
      combatTokenIds: [],
      visualSettings: _defaultVisualSettings(),
      visualTokenOpacity: {},
      visualTokenImageChoice: {},
      combatOrientation: 'horizontal',
      playerViewConfig: _defaultPlayerViewConfig(),
      gmHandledTokenId: null,
      configWindowState: { left: null, top: null, width: 1460, height: 900 }
    };
    try {
      const stored = game.settings.get(MODULE_ID, SETTING_SCENE_TRACKER_WINDOW_STATE) || {};
      return foundry.utils.mergeObject(foundry.utils.deepClone(fallback), foundry.utils.deepClone(stored));
    } catch (_) {
      return foundry.utils.deepClone(fallback);
    }
  }

  _saveWindowState(extra = {}) {
    const pos = this.position || {};
    const current = {
      left: Number.isFinite(Number(pos.left)) ? Number(pos.left) : this.state?.left ?? null,
      top: Number.isFinite(Number(pos.top)) ? Number(pos.top) : this.state?.top ?? null,
      width: Number.isFinite(Number(pos.width)) ? Number(pos.width) : this.state?.width ?? 980,
      height: Number.isFinite(Number(pos.height)) ? Number(pos.height) : this.state?.height ?? 720,
      displayMode: this.displayMode || this.state?.displayMode || 'overview',
      visibleTokenIds: Array.isArray(this.visibleTokenIds) ? this.visibleTokenIds.map(String) : [],
      combatTokenIds: Array.isArray(this.combatTokenIds) ? this.combatTokenIds.map(String) : [],
      visualSettings: foundry.utils.mergeObject(_defaultVisualSettings(), foundry.utils.deepClone(this.visualSettings || {})),
      visualTokenOpacity: foundry.utils.deepClone(this.visualTokenOpacity || {}),
      visualTokenImageChoice: foundry.utils.deepClone(this.visualTokenImageChoice || {}),
      combatOrientation: ['horizontal', 'vertical'].includes(String(this.combatOrientation)) ? String(this.combatOrientation) : 'horizontal',
      playerViewConfig: foundry.utils.mergeObject(_defaultPlayerViewConfig(), foundry.utils.deepClone(this.playerViewConfig || {})),
      gmHandledTokenId: this.gmHandledTokenId || null,
      configWindowState: foundry.utils.deepClone(this.state?.configWindowState || { left: null, top: null, width: 1460, height: 900 }),
      ...extra
    };
    this.state = foundry.utils.deepClone(current);
    try {
      game.settings.set(MODULE_ID, SETTING_SCENE_TRACKER_WINDOW_STATE, current);
    } catch (_) {}
  }

  _getVisualSettings() {
    return foundry.utils.mergeObject(_defaultVisualSettings(), foundry.utils.deepClone(this.visualSettings || {}));
  }

  _getPerTokenOpacity(tokenId, visuals = this._getVisualSettings()) {
    const key = String(tokenId || '');
    const raw = this.visualTokenOpacity?.[key];
    if (raw === '' || raw == null || Number.isNaN(Number(raw))) return Number(visuals.backgroundOpacity) || 40;
    return _clamp(Number(raw), 0, 100);
  }

  _getPerTokenImageChoice(tokenId) {
    const key = String(tokenId || '');
    const raw = foundry.utils.deepClone(this.visualTokenImageChoice?.[key] || {});
    return { mode: String(raw.mode || 'auto'), custom: String(raw.custom || '').trim() };
  }

  _buildCardStyle(row, visuals = this._getVisualSettings()) {
    const image = row?.actorImg || row?.img || '';
    if (!visuals?.usePortraitBackground || !image) return '';
    const esc = String(image).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const opacity = _clamp((this._getPerTokenOpacity(row?.tokenId, visuals) || 40) / 100, 0, 0.95);
    const overlay = _clamp((Number(visuals.overlayOpacity) || 60) / 100, 0.05, 0.95);
    const bgSize = ['cover', 'contain'].includes(String(visuals.backgroundSize || 'cover')) ? String(visuals.backgroundSize) : 'cover';
    return `--ol-card-bg-image:url("${esc}"); --ol-card-bg-opacity:${opacity}; --ol-card-overlay-opacity:${overlay}; --ol-card-bg-size:${bgSize};`;
  }

  _decorateRows(rows = []) {
    const visuals = this._getVisualSettings();
    return rows.map((row) => ({
      ...row,
      hasPortraitBackground: !!visuals.usePortraitBackground && !!(row.actorImg || row.img),
      cardStyle: this._buildCardStyle(row, visuals),
      showAvatar: !visuals.usePortraitBackground
    }));
  }

  _openVisualConfig() {
    return this._openSelectionConfig({ focusVisual: true });
  }

  _getSceneTokens() {
    return _sortTokensByName(Array.from(canvas?.tokens?.placeables || []).filter((t) => t?.actor));
  }

  _getTokenById(id) {
    const sid = String(id || '');
    return canvas?.tokens?.get?.(sid) || canvas?.tokens?.placeables?.find?.((t) => String(t.id) === sid) || null;
  }

  _getSceneCombat() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return null;
    return game.combats?.find?.((c) => String(c.scene?.id || c.scene) === String(sceneId)) || null;
  }

  _getEffectiveVisibleIds(tokens = this._getSceneTokens()) {
    const tokenIds = tokens.map((t) => String(t.id));
    if (!this.visibleTokenIds.length) return tokenIds;
    return tokenIds.filter((id) => this.visibleTokenIds.includes(id));
  }

  _getEffectiveCombatIds(tokens = this._getSceneTokens()) {
    const tokenIds = tokens.map((t) => String(t.id));
    if (this.combatTokenIds.length) return tokenIds.filter((id) => this.combatTokenIds.includes(id));
    return this._getEffectiveVisibleIds(tokens);
  }

  _getOverviewRows(tokens = this._getSceneTokens()) {
    const visibleIds = new Set(this._getEffectiveVisibleIds(tokens));
    const targetedTokenId = String(Array.from(game.user?.targets || [])[0]?.id || '');
    const rows = tokens
      .filter((token) => visibleIds.has(String(token.id)))
      .map((token) => _buildRow(token, {
        selectionVisible: visibleIds.has(String(token.id)),
        selectionCombat: this._getEffectiveCombatIds(tokens).includes(String(token.id)),
        isGmHandled: this.gmHandledTokenId === String(token.id),
        targetedTokenId,
        imageChoice: this._getPerTokenImageChoice(token.id)
      }));

    rows.sort((a, b) => Number(b.isPC) - Number(a.isPC) || a.tokenName.localeCompare(b.tokenName, 'es'));
    return rows;
  }

  _getCombatRows(tokens = this._getSceneTokens()) {
    const combat = this._getSceneCombat();
    const selectedIds = this._getEffectiveCombatIds(tokens);
    const tokenMap = new Map(tokens.map((t) => [String(t.id), t]));
    const combatants = Array.from(combat?.combatants || []);
    const combatantByTokenId = new Map(combatants.map((c) => [String(c.tokenId), c]));
    const turnOrder = new Map(Array.from(combat?.turns || []).map((c, idx) => [String(c.tokenId), idx]));
    const activeTokenId = String(combat?.combatant?.tokenId || '');
    const targetedTokenId = String(Array.from(game.user?.targets || [])[0]?.id || '');

    const rows = selectedIds
      .map((tokenId) => {
        const token = tokenMap.get(String(tokenId));
        if (!token?.actor) return null;
        const combatant = combatantByTokenId.get(String(tokenId));
        return _buildRow(token, {
          initiative: combatant?.initiative,
          turnIndex: turnOrder.has(String(tokenId)) ? turnOrder.get(String(tokenId)) + 1 : null,
          isActiveTurn: activeTokenId === String(tokenId),
          inCombat: !!combatant,
          pendingInitiative: !combatant || combatant.initiative === null || combatant.initiative === undefined,
          selectionVisible: this._getEffectiveVisibleIds(tokens).includes(String(tokenId)),
          selectionCombat: true,
          isGmHandled: this.gmHandledTokenId === String(tokenId),
          targetedTokenId,
          imageChoice: this._getPerTokenImageChoice(tokenId)
        });
      })
      .filter(Boolean);

    rows.sort((a, b) => {
      const ai = turnOrder.has(a.tokenId) ? turnOrder.get(a.tokenId) : Number.MAX_SAFE_INTEGER;
      const bi = turnOrder.has(b.tokenId) ? turnOrder.get(b.tokenId) : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      if (a.hasInitiative !== b.hasInitiative) return Number(b.hasInitiative) - Number(a.hasInitiative);
      if (a.hasInitiative && b.hasInitiative && a.initiative !== b.initiative) return (b.initiative || 0) - (a.initiative || 0);
      return a.tokenName.localeCompare(b.tokenName, 'es');
    });

    const activeIndex = rows.findIndex((row) => row.isActiveTurn);
    if (activeIndex > 0) {
      return rows.slice(activeIndex).concat(rows.slice(0, activeIndex));
    }
    return rows;
  }

  _buildCombatMeta(rows = []) {
    const combat = this._getSceneCombat();
    const selectedCount = rows.length;
    const rolledCount = rows.filter((r) => r.hasInitiative).length;
    const pendingCount = rows.filter((r) => !r.hasInitiative).length;
    const pendingPlayers = rows.filter((r) => r.isPC && !r.hasInitiative).length;
    const pendingNpcs = rows.filter((r) => !r.isPC && !r.hasInitiative).length;
    return {
      hasCombat: !!combat,
      combatRound: safeNum(combat?.round, 0),
      combatStarted: !!combat && safeNum(combat?.round, 0) > 0,
      selectedCount,
      rolledCount,
      pendingCount,
      pendingPlayers,
      pendingNpcs,
      activeName: combat?.combatant?.token?.name || combat?.combatant?.actor?.name || null
    };
  }

  _buildPlayerPublicState() {
    const tokens = this._getSceneTokens();
    const combatRows = this._getCombatRows(tokens);
    return {
      active: this.displayMode === 'combat',
      displayMode: this.displayMode,
      sceneId: canvas?.scene?.id || null,
      sceneName: canvas?.scene?.name || 'Escena actual',
      orderedTokenIds: combatRows.map((r) => String(r.tokenId)),
      combatTokenIds: this._getEffectiveCombatIds(tokens).map(String),
      gmHandledTokenId: String(this.gmHandledTokenId || ''),
      combatMeta: this._buildCombatMeta(combatRows),
      playerViewConfig: foundry.utils.mergeObject(_defaultPlayerViewConfig(), foundry.utils.deepClone(this.playerViewConfig || {})),
      visualSettings: foundry.utils.mergeObject(_defaultVisualSettings(), foundry.utils.deepClone(this.visualSettings || {})),
      visualTokenOpacity: foundry.utils.deepClone(this.visualTokenOpacity || {}),
      visualTokenImageChoice: foundry.utils.deepClone(this.visualTokenImageChoice || {}),
      timestamp: Date.now()
    };
  }

  async _publishPlayerSceneState(forceClose = false) {
    if (!game.user?.isGM) return;
    const state = forceClose
      ? { ...this._buildPlayerPublicState(), active: false, displayMode: 'overview', timestamp: Date.now() }
      : this._buildPlayerPublicState();
    try {
      await game.settings.set(MODULE_ID, SETTING_PLAYER_SCENE_PUBLIC_STATE, state);
    } catch (_) {}
    try {
      game.socket?.emit?.(SOCKET_NS, { type: forceClose || !state.active ? 'playerSceneClose' : 'playerSceneState', state });
    } catch (_) {}
  }

  async getData() {
    const tokens = this._getSceneTokens();
    const visibleIds = this._getEffectiveVisibleIds(tokens);
    const combatIds = this._getEffectiveCombatIds(tokens);
    const isCombatMode = this.displayMode === 'combat';
    const rows = this._decorateRows(isCombatMode ? this._getCombatRows(tokens) : this._getOverviewRows(tokens));
    const meta = this._buildCombatMeta(isCombatMode ? rows : []);
    const gmHandled = this._getTokenById(this.gmHandledTokenId);

    return {
      sceneName: canvas?.scene?.name || 'Escena actual',
      hasScene: !!canvas?.scene,
      isCombatMode,
      rows,
      visibleCount: visibleIds.length,
      totalSceneCount: tokens.length,
      visibleSummary: this.visibleTokenIds.length ? `${visibleIds.length} seleccionados` : 'Todos',
      combatSummary: this.combatTokenIds.length ? `${combatIds.length} seleccionados` : 'Usa visibles',
      gmHandledName: gmHandled?.name || gmHandled?.actor?.name || null,
      modeButtons: [
        { value: 'overview', label: 'General', title: 'Vista general', active: !isCombatMode },
        { value: 'combat', label: 'Combate', title: 'Modo combate', active: isCombatMode }
      ],
      combatMeta: meta,
      damageLedger: getDamageLedgerView(),
      visualSettings: this._getVisualSettings(),
      combatOrientation: this.combatOrientation,
      isCombatVertical: this.combatOrientation === 'vertical'
    };
  }

  _snapshotWindowState() {
    try {
      const pos = this.position || {};
      this.state = {
        ...(this.state || {}),
        left: Number.isFinite(pos.left) ? pos.left : this.state?.left ?? null,
        top: Number.isFinite(pos.top) ? pos.top : this.state?.top ?? null,
        width: Number.isFinite(pos.width) ? pos.width : this.state?.width ?? null,
        height: Number.isFinite(pos.height) ? pos.height : this.state?.height ?? null,
        displayMode: this.displayMode,
        visibleTokenIds: Array.from(this.visibleTokenIds || []).map(String),
        combatTokenIds: Array.from(this.combatTokenIds || []).map(String),
        visualSettings: foundry.utils.mergeObject(_defaultVisualSettings(), foundry.utils.deepClone(this.visualSettings || {})),
        visualTokenOpacity: foundry.utils.deepClone(this.visualTokenOpacity || {}),
        visualTokenImageChoice: foundry.utils.deepClone(this.visualTokenImageChoice || {}),
        combatOrientation: ['horizontal', 'vertical'].includes(String(this.combatOrientation)) ? String(this.combatOrientation) : 'horizontal',
        playerViewConfig: foundry.utils.mergeObject(_defaultPlayerViewConfig(), foundry.utils.deepClone(this.playerViewConfig || {})),
        gmHandledTokenId: String(this.gmHandledTokenId || ''),
        configWindowState: foundry.utils.deepClone(this.state?.configWindowState || { left: null, top: null, width: 1460, height: 900 })
      };
    } catch (_) {}
  }

  async _persistState() {
    try {
      this._snapshotWindowState();
      await game.settings.set(MODULE_ID, SETTING_SCENE_TRACKER_WINDOW_STATE, this.state);
    } catch (_) {}
    try {
      await this._publishPlayerSceneState(false);
    } catch (_) {}
  }

  async _render(force = false, options = {}) {
    this._snapshotWindowState();
    const st = this.state || {};
    if (!Number.isFinite(options.left) && Number.isFinite(st.left)) options.left = st.left;
    if (!Number.isFinite(options.top) && Number.isFinite(st.top)) options.top = st.top;
    if (!Number.isFinite(options.width) && Number.isFinite(st.width)) options.width = st.width;
    if (!Number.isFinite(options.height) && Number.isFinite(st.height)) options.height = st.height;
    const out = await super._render(force, options);
    this._registerHooks();
    try { await this._publishPlayerSceneState(false); } catch (_) {}
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
      this._persistState?.();
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

    html.on('click', '[data-action="refresh"]', (ev) => {
      ev.preventDefault();
      this.render(true);
    });

    html.on('click', '[data-action="close-monitor"]', (ev) => {
      ev.preventDefault();
      this.close();
    });

    html.on('click', '[data-action="set-mode"]', (ev) => {
      ev.preventDefault();
      this.displayMode = String(ev.currentTarget.dataset.mode || 'overview');
      this._persistState();
      this.render(true);
    });

    html.on('click', '[data-action="open-config"]', (ev) => {
      ev.preventDefault();
      this._openSelectionConfig();
    });

    html.on('click', '[data-action="configure-combat"]', async (ev) => {
      ev.preventDefault();
      await this._openSelectionConfig();
      this.displayMode = 'combat';
      this._persistState();
      this.render(true);
    });

    html.on('click', '[data-action="start-combat"]', async (ev) => {
      ev.preventDefault();
      await this._startCombat();
    });

    html.on('click', '[data-action="end-combat"]', async (ev) => {
      ev.preventDefault();
      await this._endCombat();
    });

    html.on('click', '[data-action="next-turn"]', async (ev) => {
      ev.preventDefault();
      const combat = this._getSceneCombat();
      if (!combat) return ui.notifications?.warn?.('No hay combate activo en esta escena.');
      await combat.nextTurn();
      this.render(true);
    });

    html.on('click', '[data-action="prev-turn"]', async (ev) => {
      ev.preventDefault();
      const combat = this._getSceneCombat();
      if (!combat) return ui.notifications?.warn?.('No hay combate activo en esta escena.');
      await combat.previousTurn();
      this.render(true);
    });

    html.on('click', '[data-action="roll-init-all"]', async (ev) => {
      ev.preventDefault();
      await this._rollInitiativeForSelection('all');
    });

    html.on('click', '[data-action="roll-init-npc"]', async (ev) => {
      ev.preventDefault();
      await this._rollInitiativeForSelection('npc');
    });

    html.on('click', '[data-action="roll-init-one"]', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const tokenId = String(ev.currentTarget.dataset.tokenId || '');
      if (!tokenId) return;
      await this._rollInitiativeForSelection('one', tokenId);
    });

    html.on('click', '[data-action="toggle-damage-ledger"]', async (ev) => {
      ev.preventDefault();
      await toggleDamageLedgerActive();
      this.render(true);
    });

    html.on('click', '[data-action="apply-damage-ledger-all"]', async (ev) => {
      ev.preventDefault();
      await applyAllPendingDamageLedger();
      this.render(true);
    });

    html.on('click', '[data-action="apply-damage-ledger-line"]', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const lineId = String(ev.currentTarget.dataset.lineId || '');
      if (!lineId) return;
      try {
        await applyDamageLedgerLine(lineId);
      } catch (err) {
        ui.notifications?.warn?.(err?.message || String(err));
      }
      this.render(true);
    });

    html.on('click', '[data-action="delete-damage-ledger-line"]', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const lineId = String(ev.currentTarget.dataset.lineId || '');
      if (lineId) await deleteDamageLedgerLine(lineId);
      this.render(true);
    });

    html.on('click', '[data-action="restore-damage-ledger-line"]', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const lineId = String(ev.currentTarget.dataset.lineId || '');
      if (lineId) await restoreDamageLedgerLine(lineId);
      this.render(true);
    });

    html.on('click', '[data-action="undo-damage-ledger-delete"]', async (ev) => {
      ev.preventDefault();
      const restored = await undoDamageLedgerDelete();
      if (!restored) ui.notifications?.warn?.('No hay borrados para deshacer.');
      this.render(true);
    });

    html.on('click', '[data-action="clear-damage-ledger-applied"]', async (ev) => {
      ev.preventDefault();
      await clearDamageLedgerApplied();
      this.render(true);
    });

    html.on('click', '[data-action="clear-damage-ledger-all"]', async (ev) => {
      ev.preventDefault();
      const ok = window.confirm('¿Vaciar todo el historial de daño pendiente?');
      if (!ok) return;
      await clearDamageLedgerAll();
      this.render(true);
    });

    html.on('click', '[data-token-id]', async (ev) => {
      if ($(ev.target).closest('[data-action], [data-hp-token-id]').length) return;
      const id = String(ev.currentTarget.dataset.tokenId || '');
      const token = this._getTokenById(id);
      if (!token) return;
      try {
        await canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
        token.control({ releaseOthers: true });
      } catch {}
    });

    html.on('dblclick', '[data-token-id]', async (ev) => {
      if ($(ev.target).closest('[data-action], [data-hp-token-id]').length) return;
      ev.preventDefault();
      ev.stopPropagation();
      const id = String(ev.currentTarget.dataset.tokenId || '');
      const token = this._getTokenById(id);
      if (!token?.actor) return;
      try {
        game.olAttack?.open?.({ actor: token.actor, token });
      } catch (err) {
        console.warn('[ol-attack] No se pudo abrir la macro desde el monitor', err);
      }
    });

    html.on('contextmenu', '[data-token-id]', async (ev) => {
      const interactiveSelector = '[data-action], [data-hp-token-id], button, input, select, textarea, a, label';
      if ($(ev.target).closest(interactiveSelector).length) return;
      ev.preventDefault();
      ev.stopPropagation();
      const id = String(ev.currentTarget.dataset.tokenId || '');
      await this._openTokenContextMenu(id, { x: ev.clientX, y: ev.clientY });
    });

    html.on('dblclick', '[data-hp-token-id]', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const id = String(ev.currentTarget.dataset.hpTokenId || '');
      await this._promptSetHp(id);
    });
  }

  _buildConfigHtml(tokens, options = {}) {
    const visuals = this._getVisualSettings();
    const visibleSet = new Set(this.visibleTokenIds.length ? this.visibleTokenIds : tokens.map((t) => String(t.id)));
    const combatSet = new Set(this.combatTokenIds);
    const firstTokenId = String(options.selectedTokenId || tokens[0]?.id || '');

    const rows = tokens.map((token) => {
      const id = String(token.id);
      const actor = token.actor;
      const type = actor?.hasPlayerOwner ? 'PJ' : 'PNJ';
      const rowOpacity = this._getPerTokenOpacity(id, visuals);
      const choice = this._getPerTokenImageChoice(id);
      const selectedMode = String(choice.mode || 'auto');
      const available = _collectAvailablePortraitOptions(actor, token);
      const portraits = _pickPortraits(actor, token, choice);
      const search = foundry.utils.escapeHTML(`${token.name || actor?.name || ''} ${type} ${token.document?.hidden ? 'oculto' : ''}`.toLowerCase());
      const sub = `${type}${token.document?.hidden ? ' · Oculto' : ''}${_isGenericPortrait(actor?.img) ? ' · Auto usa token' : ' · Auto usa actor'}`;
      return `
        <article class="ol-monitor-token-row ${id === firstTokenId ? 'is-selected' : ''}" data-token-id="${id}" data-kind="${actor?.hasPlayerOwner ? 'pc' : 'npc'}" data-search="${search}">
          <div class="ol-monitor-token-row-main" data-role="selectToken" data-token-id="${id}" title="Seleccionar ficha para editar imagen y opacidad">
            <img class="ol-monitor-token-row-thumb" src="${foundry.utils.escapeHTML(portraits.avatar || portraits.portrait || 'icons/svg/mystery-man.svg')}" alt="${foundry.utils.escapeHTML(token.name || actor?.name || '')}">
            <div class="ol-monitor-token-row-meta">
              <div class="ol-monitor-conf-name">${foundry.utils.escapeHTML(token.name || actor?.name || '')}</div>
              <div class="ol-monitor-conf-sub">${foundry.utils.escapeHTML(sub)}</div>
            </div>
          </div>
          <div class="ol-monitor-token-row-actions">
            <label class="ol-monitor-toggle compact" title="Mostrar en el monitor">
              <span>Ver</span>
              <input type="checkbox" data-role="visible" data-token-id="${id}" ${visibleSet.has(id) ? 'checked' : ''}>
            </label>
            <label class="ol-monitor-toggle compact" title="Incluir en el modo combate">
              <span>Comb.</span>
              <input type="checkbox" data-role="combat" data-token-id="${id}" ${combatSet.has(id) ? 'checked' : ''}>
            </label>
            <button type="button" class="ol-mini-btn ol-monitor-token-edit-btn" data-role="selectToken" data-token-id="${id}">Imagen</button>
          </div>
          <div class="ol-monitor-token-hidden" aria-hidden="true">
            <input type="range" data-role="opacity" data-token-id="${id}" min="0" max="100" step="5" value="${rowOpacity}">
            <select data-role="imageMode" data-token-id="${id}">
              <option value="auto" ${selectedMode === 'auto' ? 'selected' : ''}>Auto</option>
              ${available.map((opt) => `<option value="${opt.key}" ${selectedMode === String(opt.key) ? 'selected' : ''}>${foundry.utils.escapeHTML(opt.label)}</option>`).join('')}
              <option value="custom" ${selectedMode === 'custom' ? 'selected' : ''}>Archivo / URL personalizada</option>
            </select>
            <input type="text" data-role="imageCustom" data-token-id="${id}" value="${foundry.utils.escapeHTML(String(choice.custom || ''))}">
          </div>
        </article>`;
    }).join('');

    return `
      <div class="ol-monitor-conf ol-monitor-conf-v173" data-selected-token-id="${firstTokenId}">
        <div class="ol-monitor-layout">
          <section class="ol-monitor-panel ol-monitor-panel-list">
            <div class="ol-monitor-conf-section-title">Listado y combate</div>
            <div class="ol-monitor-conf-toolbar is-compact">
              <label class="ol-monitor-conf-search">
                <i class="fas fa-search"></i>
                <input type="search" data-role="tokenFilter" placeholder="Buscar ficha, token o tipo...">
              </label>
              <div class="ol-monitor-conf-filterchips">
                <button type="button" class="ol-mini-btn selected" data-role="kindFilter" data-kind="all">Todos</button>
                <button type="button" class="ol-mini-btn" data-role="kindFilter" data-kind="pc">PJs</button>
                <button type="button" class="ol-mini-btn" data-role="kindFilter" data-kind="npc">PNJs</button>
              </div>
              <div class="ol-monitor-conf-toolbar-actions">
                <button type="button" class="ol-mini-btn" data-role="bulkVisibleFiltered">Ver filtrados</button>
                <button type="button" class="ol-mini-btn" data-role="bulkCombatFiltered">Combate filtrados</button>
                <button type="button" class="ol-mini-btn" data-role="bulkClearFiltered">Limpiar filtrados</button>
              </div>
            </div>
            <div class="ol-monitor-token-list" data-role="tokenList">${rows}</div>
            <p class="ol-monitor-conf-hint">Selecciona una ficha en la lista para editar su imagen y opacidad en el panel de la derecha. El listado queda para marcar rápido <b>Ver</b> y <b>Combate</b>; los ajustes visuales se hacen en un único inspector.</p>
          </section>

          <aside class="ol-monitor-panel ol-monitor-panel-inspector">
            <div class="ol-monitor-conf-section-title">Inspector visual</div>
            <div class="ol-monitor-inspector" data-role="inspectorRoot">
              <div class="ol-monitor-inspector-empty" data-role="inspectorEmpty">Selecciona una ficha de la lista para configurar su imagen.</div>
              <div class="ol-monitor-inspector-body" data-role="inspectorBody">
                <div class="ol-monitor-inspector-header">
                  <img data-role="inspectorPreview" src="icons/svg/mystery-man.svg" alt="Vista previa">
                  <div class="ol-monitor-inspector-meta">
                    <div class="ol-monitor-inspector-name" data-role="inspectorName">—</div>
                    <div class="ol-monitor-inspector-sub" data-role="inspectorSub">—</div>
                    <div class="ol-monitor-inspector-label" data-role="inspectorResolvedLabel">—</div>
                  </div>
                </div>
                <div class="ol-monitor-inspector-section">
                  <div class="ol-monitor-inspector-section-title">Fuente rápida</div>
                  <div class="ol-monitor-image-quick" data-role="inspectorQuickWrap"></div>
                </div>
                <label class="ol-monitor-conf-field">
                  <span>Fuente de imagen</span>
                  <select data-role="inspectorImageMode"></select>
                </label>
                <div class="ol-monitor-image-inputrow single-source">
                  <label class="ol-monitor-conf-field">
                    <span>Archivo / URL</span>
                    <input type="text" data-role="inspectorImageCustom" placeholder="Ruta del archivo o URL personalizada">
                  </label>
                  <button type="button" class="ol-mini-btn ol-monitor-image-browse" data-role="inspectorImageBrowse">Explorar…</button>
                </div>
                <label class="ol-monitor-conf-field ol-monitor-conf-field-range boxed">
                  <span>Opacidad individual</span>
                  <div class="ol-monitor-conf-opacity">
                    <input type="range" data-role="inspectorOpacity" min="0" max="100" step="5" value="40">
                    <b data-role="inspectorOpacityValue">40%</b>
                  </div>
                </label>
              </div>
            </div>

            <div class="ol-monitor-conf-split stacked">
              <div class="ol-monitor-panel-subsection">
                <div class="ol-monitor-conf-section-title small">Visual general</div>
                <div class="ol-visual-conf embedded compact">
                  <label class="ol-visual-conf-row">
                    <span>Orientación del carrusel de combate</span>
                    <select name="combatOrientation">
                      <option value="horizontal" ${String(this.combatOrientation) === 'horizontal' ? 'selected' : ''}>Horizontal</option>
                      <option value="vertical" ${String(this.combatOrientation) === 'vertical' ? 'selected' : ''}>Vertical</option>
                    </select>
                    <b>${String(this.combatOrientation) === 'vertical' ? 'Columna' : 'Fila'}</b>
                  </label>
                  <label class="ol-visual-conf-row checkbox">
                    <input type="checkbox" name="usePortraitBackground" ${visuals.usePortraitBackground ? 'checked' : ''}>
                    <span>Usar imagen de actor/token como fondo de la tarjeta</span>
                  </label>
                  <label class="ol-visual-conf-row">
                    <span>Opacidad por defecto</span>
                    <input type="range" name="backgroundOpacity" min="0" max="100" step="5" value="${Number(visuals.backgroundOpacity) || 40}">
                    <b data-role="backgroundOpacityValue">${Number(visuals.backgroundOpacity) || 40}%</b>
                  </label>
                  <label class="ol-visual-conf-row">
                    <span>Oscurecer fondo para legibilidad</span>
                    <input type="range" name="overlayOpacity" min="20" max="90" step="5" value="${Number(visuals.overlayOpacity) || 60}">
                    <b data-role="overlayOpacityValue">${Number(visuals.overlayOpacity) || 60}%</b>
                  </label>
                  <label class="ol-visual-conf-row">
                    <span>Ajuste de la imagen</span>
                    <select name="backgroundSize">
                      <option value="cover" ${String(visuals.backgroundSize) === 'cover' ? 'selected' : ''}>Cubrir la tarjeta</option>
                      <option value="contain" ${String(visuals.backgroundSize) === 'contain' ? 'selected' : ''}>Mostrar completa</option>
                    </select>
                  </label>
                </div>
              </div>
              <div class="ol-monitor-panel-subsection">
                <div class="ol-monitor-conf-section-title small">Monitor resumido para jugadores</div>
                <div class="ol-visual-conf embedded compact">
                  <label class="ol-visual-conf-row checkbox">
                    <input type="checkbox" name="playerShowPCs" ${this.playerViewConfig?.showPCs ? 'checked' : ''}>
                    <span>Mostrar personajes jugadores (PJs)</span>
                  </label>
                  <label class="ol-visual-conf-row checkbox">
                    <input type="checkbox" name="playerShowNPCs" ${this.playerViewConfig?.showNPCs ? 'checked' : ''}>
                    <span>Mostrar PNJs</span>
                  </label>
                  <label class="ol-visual-conf-row checkbox">
                    <input type="checkbox" name="playerShowHP" ${this.playerViewConfig?.showHP ? 'checked' : ''}>
                    <span>Mostrar PG</span>
                  </label>
                  <label class="ol-visual-conf-row checkbox">
                    <input type="checkbox" name="playerShowTempHP" ${this.playerViewConfig?.showTempHP ? 'checked' : ''}>
                    <span>Mostrar PG temporales</span>
                  </label>
                  <label class="ol-visual-conf-row checkbox">
                    <input type="checkbox" name="playerShowResources" ${this.playerViewConfig?.showResources ? 'checked' : ''}>
                    <span>Mostrar usos limitados / recursos</span>
                  </label>
                  <label class="ol-visual-conf-row checkbox">
                    <input type="checkbox" name="playerShowStatuses" ${this.playerViewConfig?.showStatuses ? 'checked' : ''}>
                    <span>Mostrar estados</span>
                  </label>
                  <label class="ol-visual-conf-row checkbox">
                    <input type="checkbox" name="playerShowQuickTraits" ${this.playerViewConfig?.showQuickTraits ? 'checked' : ''}>
                    <span>Mostrar etiquetas rápidas</span>
                  </label>
                  <label class="ol-visual-conf-row checkbox">
                    <input type="checkbox" name="playerShowWeaknesses" ${this.playerViewConfig?.showWeaknesses ? 'checked' : ''}>
                    <span>Mostrar vulnerabilidades / resistencias / inmunidades</span>
                  </label>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>`;
  }

  async _openSelectionConfig(options = {}) {
    const tokens = this._getSceneTokens();
    if (!tokens.length) return ui.notifications?.warn?.('No hay tokens con actor en la escena.');
    if (this._sceneConfigApp?.rendered) {
      try {
        if (options?.selectedTokenId) this._sceneConfigApp.draft.selectedTokenId = String(options.selectedTokenId);
        this._sceneConfigApp.focusVisual = !!options.focusVisual;
        this._sceneConfigApp.render(true);
        this._sceneConfigApp.bringToTop?.();
      } catch (_) {}
      return this._sceneConfigApp.waitForClose();
    }
    const app = new OLSceneTrackerConfigApp(this, options);
    this._sceneConfigApp = app;
    const waiter = app.waitForClose();
    app.render(true);
    waiter.finally(() => {
      if (this._sceneConfigApp === app) this._sceneConfigApp = null;
    });
    return waiter;
  }

  async _openTokenContextMenu(tokenId, point = {}) {
    const token = this._getTokenById(tokenId);
    if (!token?.actor) return;
    const isTargeted = Array.from(game.user?.targets || []).some((t) => String(t.id) === String(tokenId));
    const isHandled = this.gmHandledTokenId === String(tokenId);
    closeOlContextMenu();
    openOlContextMenu({
      x: safeNum(point.x, window.innerWidth / 2),
      y: safeNum(point.y, window.innerHeight / 2),
      title: token.name || token.actor.name,
      items: [
        {
          label: isTargeted ? 'Quitar objetivo' : 'Marcar objetivo',
          action: async () => {
            await this._toggleTargetToken(tokenId, !isTargeted);
          }
        },
        ...(game.user?.isGM ? [{
          label: isHandled ? 'Dejar de manejar' : 'Manejar este personaje',
          action: async () => {
            this._setHandledToken(isHandled ? null : tokenId);
          }
        }] : []),
        { type: 'separator' },
        {
          label: 'Aplicar estado',
          action: async () => {
            await openStatusPicker({ actor: token.actor, token, mode: 'apply', title: `Aplicar estado · ${token.name || token.actor.name}` });
          }
        },
        {
          label: 'Quitar estado',
          action: async () => {
            await openStatusPicker({ actor: token.actor, token, mode: 'remove', title: `Quitar estado · ${token.name || token.actor.name}` });
          }
        },
        { type: 'separator' },
        {
          label: 'Abrir macro',
          action: async () => {
            game.olAttack?.open?.({ actor: token.actor, token });
          }
        }
      ]
    });
  }

  async _toggleTargetToken(tokenId, state = true) {
    const token = this._getTokenById(tokenId);
    if (!token) return;
    try {
      token.setTarget(!!state, { user: game.user, releaseOthers: !!state, groupSelection: false });
      this.render(false);
    } catch {
      ui.notifications?.warn?.('No se pudo marcar el token como objetivo.');
    }
  }

  _setHandledToken(tokenId = null) {
    this.gmHandledTokenId = tokenId ? String(tokenId) : '';
    if (this.gmHandledTokenId) game.olAttack?.setHandledToken?.(this.gmHandledTokenId);
    else game.olAttack?.clearHandledToken?.();
    this._persistState();
    this.render(false);
  }

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
      ui.notifications?.warn?.('No has seleccionado ningún personaje para el modo combate.');
      return null;
    }

    let combat = await this._getOrCreateSceneCombat();
    if (!combat) return null;

    const tokenMap = new Map(tokens.map((t) => [String(t.id), t]));
    const existingByToken = new Map(Array.from(combat.combatants || []).map((c) => [String(c.tokenId), c]));
    const toRemove = Array.from(combat.combatants || [])
      .filter((combatant) => !selectedIds.includes(String(combatant.tokenId)))
      .map((combatant) => combatant.id)
      .filter(Boolean);

    const toAdd = selectedIds
      .filter((tokenId) => !existingByToken.has(String(tokenId)))
      .map((tokenId) => {
        const token = tokenMap.get(String(tokenId));
        return {
          tokenId,
          actorId: token?.actor?.id,
          hidden: !!token?.document?.hidden
        };
      });

    if (toRemove.length) await combat.deleteEmbeddedDocuments('Combatant', toRemove);
    if (toAdd.length) await combat.createEmbeddedDocuments('Combatant', toAdd);

    return game.combats?.get?.(combat.id) || combat;
  }

  async _startCombat() {
    if (!this.combatTokenIds.length) {
      const configured = await this._openSelectionConfig();
      if (!configured) return;
    }
    if (!this.combatTokenIds.length) {
      ui.notifications?.warn?.('Antes de iniciar el combate debes seleccionar quién entra en conflicto.');
      return;
    }
    const combat = await this._syncCombatParticipants();
    if (!combat) return;
    if (safeNum(combat.round, 0) <= 0) await combat.startCombat();
    this.displayMode = 'combat';
    this._persistState();
    this.render(true);
  }

  async _endCombat() {
    const combat = this._getSceneCombat();
    if (!combat) return ui.notifications?.warn?.('No hay combate activo en esta escena.');
    try {
      if (typeof combat.endCombat === 'function') await combat.endCombat();
      else await combat.delete();
    } catch {
      try { await combat.delete(); } catch {}
    }
    this.displayMode = 'overview';
    this._persistState();
    this.render(true);
  }

  async _rollInitiativeForSelection(scope = 'all', singleTokenId = null) {
    if (scope === 'one' && singleTokenId && !this.combatTokenIds.length) {
      this.combatTokenIds = [String(singleTokenId)];
    }
    if (!this.combatTokenIds.length && scope !== 'one') {
      const configured = await this._openSelectionConfig();
      if (!configured) return;
    }
    if (!this.combatTokenIds.length && scope !== 'one') {
      ui.notifications?.warn?.('Selecciona primero los participantes del combate para tirar la iniciativa.');
      return;
    }
    const combat = await this._syncCombatParticipants();
    if (!combat) return;

    const tokens = this._getSceneTokens();
    const tokenMap = new Map(tokens.map((t) => [String(t.id), t]));
    let tokenIds = this._getEffectiveCombatIds(tokens);

    if (scope === 'npc') tokenIds = tokenIds.filter((id) => !tokenMap.get(String(id))?.actor?.hasPlayerOwner);
    if (scope === 'one' && singleTokenId) tokenIds = [String(singleTokenId)];

    if (!tokenIds.length) {
      ui.notifications?.warn?.('No hay participantes válidos para tirar iniciativa.');
      return;
    }

    const combatantIds = Array.from(combat.combatants || [])
      .filter((c) => tokenIds.includes(String(c.tokenId)))
      .map((c) => c.id)
      .filter(Boolean);

    if (!combatantIds.length) {
      ui.notifications?.warn?.('No se han encontrado combatientes para esa tirada de iniciativa.');
      return;
    }

    await combat.rollInitiative(combatantIds);
    this.displayMode = 'combat';
    this._persistState();
    this.render(true);
  }

  async _promptSetHp(tokenId) {
    const token = this._getTokenById(tokenId);
    const actor = token?.actor;
    if (!actor) return;
    const hp = getActorHpData(actor);
    const current = safeNum(hp.value, 0);
    const max = safeNum(hp.max, 0);
    return await new Promise((resolve) => {
      new LegacyDialog({
        title: `Modificar PG — ${actor.name}`,
        content: `
          <div style="display:flex;flex-direction:column;gap:8px;">
            <label style="font-weight:700;">PG actuales (máx. ${max})</label>
            <input type="number" name="hpValue" value="${current}" min="0" step="1" style="width:100%;">
          </div>`,
        buttons: {
          ok: {
            label: 'Guardar',
            callback: async (dlg) => {
              const raw = dlg.find('input[name="hpValue"]').val();
              const next = Math.max(0, Math.min(max, safeNum(raw, current)));
              await updateActorHpData(actor, { value: next });
              this.render(true);
              resolve(next);
            }
          },
          cancel: { label: game.i18n.localize('Cancel'), callback: () => resolve(null) }
        },
        default: 'ok'
      }, { width: 380 }).render(true);
    });
  }

  _registerHooks() {
    if (this._hookIds.length) return;
    const rerender = () => {
      if (this.rendered) this.render(false);
      if (game.user?.isGM) this._publishPlayerSceneState(false);
    };
    const on = (hook) => this._hookIds.push([hook, Hooks.on(hook, rerender)]);
    [
      'updateActor', 'updateItem', 'createItem', 'deleteItem',
      'updateActiveEffect', 'createActiveEffect', 'deleteActiveEffect',
      'updateToken', 'canvasReady', 'updateCombat', 'combatTurn', 'combatRound',
      'combatStart', 'createCombat', 'deleteCombat', 'createCombatant', 'deleteCombatant', 'updateCombatant', 'targetToken'
    ].forEach(on);
  }

  async close(options = {}) {
    clearTimeout(this._stateSaveTimer);
    try { await this._publishPlayerSceneState(true); } catch (_) {}
    await this._persistState();
    for (const [hook, id] of this._hookIds) Hooks.off(hook, id);
    this._hookIds = [];
    game.olAttack?.clearHandledToken?.();
    this.gmHandledTokenId = '';
    return super.close(options);
  }
}
