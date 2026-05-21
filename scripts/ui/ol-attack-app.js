import { MODULE_ID, FLAG_SCOPE, FLAG_VISIBLE, FLAG_OFFHAND_ENABLED, FLAG_OFFHAND_WEAPON, FLAG_AUTO_CLOSE, FLAG_RASGOS_EXTRA_DICE, FLAG_CONCENTRATION } from "../shared/constants.js";
import { LegacyApplication, LegacyDialog } from "../shared/compat.js";
import { getActorHpData, updateActorHpData } from "../shared/system-data.js";
import { gp, safeNum, escapeHtml, cleanDiceBonus, sanitizeFormulaLoose } from "../lib/utils.js";
import { getAttackItems, isCombatItem, getEquippedWeapons, getWeaponDamageType, getActorDamageBonusFormula, autoAbilityForItem } from "../lib/actor.js";
import { getActorFeatures, isMultiattackItem } from "../lib/features.js";
import { getExhaustionInfo } from "../lib/exhaustion.js";
import { getAvailableSpellSlots, hasMagicActor, consumeSpellSlot, getSpellLevel } from "../lib/spells.js";
import { migrateUserPrefsToActorIfNeeded, saveActorPrefs } from "../lib/prefs.js";
import { enrichDescription } from "../lib/utils.js";
import { getItemUses, consumeItemUse } from "../lib/uses.js";
import { getDamagePartsDetailed, getHealingPartsDetailed } from "../lib/damage.js";
import { runAction, postChoiceModeCard, isChoiceModeItem } from "../workflow/execute.js";
import { resolveActionProfile, isItemHiddenByProfile, shouldConsumeItemUseForProfile, shouldConsumeSpellSlotForProfile } from "../lib/action-profiles.js";
import { openVisibilityConfig } from "./visibility-config.js";
import { openStatusPicker } from "../lib/statuses.js";
import { openOlContextMenu, closeOlContextMenu } from "../lib/context-menu.js";

// ============================
// Hover-card (tooltip ampliado) para items (0.5s)
// ============================
let _olHoverCardEl = null;
let _olHoverTimer = null;
let _olHoverHideTimer = null;
let _olHoverPinned = false;
let _olHoverLastItemId = null;
let _olHoverLastPos = { x: 0, y: 0 };
let _olHoverReq = 0;

async function _pickTokenFromList({ title, subtitle = "", tokens = [] }) {
  if (!tokens.length) return null;
  const content = `
    <div style="font-family:Roboto,sans-serif;">
      ${subtitle ? `<div style="color:#bbb;font-size:12px;margin-bottom:8px;">${escapeHtml(subtitle)}</div>` : ""}
      <div style="display:flex;flex-direction:column;gap:6px;max-height:360px;overflow:auto;">
        ${tokens.map((t, idx) => `
          <label style="display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid #444;border-radius:10px;background:#1b1b1b;cursor:pointer;">
            <input type="radio" name="olPickTok" value="${escapeHtml(t.id)}" ${idx === 0 ? "checked" : ""}>
            <img src="${t.document.texture.src}" onerror="this.src='icons/svg/mystery-man.svg'" style="width:34px;height:34px;border-radius:8px;object-fit:cover;border:1px solid #333;background:#000;">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:800;color:#eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.name)}</div>
              <div style="font-size:11px;color:#aaa;">${escapeHtml(t.actor?.name || "")}</div>
            </div>
          </label>`).join("")}
      </div>
    </div>`;

  return await new Promise((resolve) => {
    new LegacyDialog({
      title,
      content,
      buttons: {
        ok: { label: "Elegir", callback: (html) => {
          const id = html.find("input[name='olPickTok']:checked").val();
          const tok = tokens.find((t) => t.id === id) || null;
          resolve(tok);
        } },
        cancel: { label: game.i18n.localize("OLATTACK.Cancel"), callback: () => resolve(null) }
      },
      default: "ok"
    }, { width: 460 }).render(true);
  });
}

function _ensureHoverCard() {
  if (_olHoverCardEl) return _olHoverCardEl;
  const el = document.createElement("div");
  el.className = "ol-hovercard";
  el.style.display = "none";
  el.addEventListener("mouseenter", () => {
    _olHoverPinned = true;
    if (_olHoverHideTimer) { clearTimeout(_olHoverHideTimer); _olHoverHideTimer = null; }
  });
  el.addEventListener("mouseleave", () => {
    _olHoverPinned = false;
    _scheduleHideHoverCard(120);
  });
  document.body.appendChild(el);
  _olHoverCardEl = el;
  return el;
}

function _positionHoverCard(x, y) {
  const el = _olHoverCardEl;
  if (!el) return;

  const pad = 14;
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;

  // Medir después de contenido
  const rect = el.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;

  if (left + rect.width > vw - 10) left = Math.max(10, x - rect.width - pad);
  if (top + rect.height > vh - 10) top = Math.max(10, vh - rect.height - 10);

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function _scheduleHideHoverCard(ms = 120) {
  if (_olHoverHideTimer) clearTimeout(_olHoverHideTimer);
  _olHoverHideTimer = setTimeout(() => {
    if (_olHoverPinned) return;
    if (_olHoverCardEl) _olHoverCardEl.style.display = "none";
  }, ms);
}

async function _buildHoverCardHtml(item, actor) {
  const img = item?.img || "icons/svg/mystery-man.svg";
  const name = item?.name || "Item";
  const type = item?.type ? String(item.type) : "item";

  let subtitle = type;
  try {
    if (type === "spell") {
      const lvl = Number(item?.system?.level ?? 0);
      const school = item?.system?.school ? String(item.system.school).toUpperCase() : "";
      subtitle = lvl === 0 ? `Cantrip ${school}`.trim() : `Nivel ${lvl} ${school}`.trim();
    } else if (type === "weapon") {
      const wType = item?.system?.weaponType ? String(item.system.weaponType) : "";
      subtitle = wType ? `Arma · ${wType}` : "Arma";
    } else if (type === "feat") {
      subtitle = "Rasgo / Dote";
    }
  } catch {}

  // Props (usamos getChatData si existe para sacar “los principales detalles”)
  let props = [];
  try {
    if (typeof item.getChatData === "function") {
      const chatData = await item.getChatData({ secrets: item.isOwner });
      if (Array.isArray(chatData?.properties)) props = chatData.properties.filter(Boolean).map((p) => String(p));
    }
  } catch {}

  // Descripción enriquecida
  let desc = "";
  try {
    desc = await TextEditor.enrichHTML(item?.system?.description?.value ?? "", { secrets: item?.isOwner, async: true, documents: true });
  } catch {
    desc = item?.system?.description?.value ?? "";
  }

  const propsHtml = props.length
    ? `<div class="ol-hovercard-props">${props.map((p) => `<span class="ol-hoverchip">${escapeHtml(p)}</span>`).join("")}</div>`
    : "";

  return `
    <div class="ol-hovercard-inner">
      <div class="ol-hovercard-header">
        <img src="${escapeHtml(img)}" onerror="this.src='icons/svg/mystery-man.svg'">
        <div class="ol-hovercard-headtxt">
          <div class="ol-hovercard-title">${escapeHtml(name)}</div>
          <div class="ol-hovercard-sub">${escapeHtml(subtitle)}</div>
        </div>
      </div>
      ${propsHtml}
      <div class="ol-hovercard-desc">${desc || `<span style="color:#888;">(Sin descripción)</span>`}</div>
    </div>
  `;
}


function _normCounterText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function _getSpecialCounterMeta(item, actor = null) {
  if (!item) return null;
  const resolved = resolveActionProfile(item, actor);
  const key = String(resolved?.profile?.specialCounterKey || "").trim();
  const map = {
    "bardic-inspiration": { label: "Inspiración bárdica", priority: 10 },
    "lucky": { label: "Afortunada", priority: 20 },
    "rage": { label: "Rabia", priority: 30 },
    "stone-endurance": { label: "Piel de Piedra", priority: 40 },
    "wails-from-the-grave": { label: "Lamentos desde la tumba", priority: 50 },
    "channel-divinity": { label: "Canalizar", priority: 60 },
    "warding-flare": { label: "Destello protector", priority: 70 }
  };
  return key && map[key] ? { key, ...map[key] } : null;
}

function _getSpecialCounters(actor, maxEntries = 8) {
  const counters = [];
  for (const it of actor?.items || []) {
    const u = getItemUses(it);
    if (u.max <= 0) continue;
    const meta = _getSpecialCounterMeta(it, actor);
    if (!meta) continue;
    counters.push({
      id: it.id,
      key: meta.key,
      name: it.name,
      displayName: meta.label,
      img: it.img,
      remaining: u.remaining,
      max: u.max,
      priority: meta.priority
    });
  }
  counters.sort((a, b) => (a.priority - b.priority) || a.displayName.localeCompare(b.displayName, "es"));
  return counters.slice(0, Math.max(1, Number(maxEntries) || 8));
}

function _findFeatureItem(actor, kind) {
  if (!actor?.items) return null;
  const items = actor.items?.contents || actor.items || [];
  const fromProfile = items.find((it) => String(resolveActionProfile(it, actor)?.profile?.specialFeatureKey || "") === String(kind || ""));
  if (fromProfile) return fromProfile;
  const matchers = {
    rage: [/(^|\b)(rage|furia|rabia)(\b|$)/i],
    reckless: [/Reckless|Temerari/i],
    frenzy: [/Frenzy|Frenes[ií]/i],
    sneak: [/Sneak Attack|Ataque\s+Furtivo/i],
    savage: [/Savage Attacker|Atacante\s+Salvaje/i],
    wails: [/Wails from the Grave|Lamentos\s+desde\s+la\s+tumba|Lamentos\s+de\s+la\s+tumba/i]
  };
  const regs = matchers[kind] || [];
  return items.find((it) => regs.some((rgx) => rgx.test(String(it?.name || "")) || rgx.test(String(gp(it, "system.identifier") || "")))) || null;
}


function _getLimitedUseState(item) {
  const uses = getItemUses(item);
  return { item, uses, limited: uses.max > 0, exhausted: uses.max > 0 && uses.remaining <= 0 };
}

function _refreshUsesUi(form, itemOrId, uses = null) {
  if (!form?.length || !itemOrId) return;
  const itemId = typeof itemOrId === "string" ? itemOrId : itemOrId.id;
  const data = uses || (typeof itemOrId === "string" ? null : getItemUses(itemOrId));
  if (!itemId || !data || data.max <= 0) return;
  form.find(`.ol-uses-badge[data-id="${itemId}"]`).text(`(${data.remaining}/${data.max})`);
  const chip = form.find(`.ol-counter-chip[data-id="${itemId}"]`);
  if (chip.length) {
    chip.find("b").text(String(data.remaining));
    chip.find("span").text(String(data.max));
  }
}

function _warnLimitedUseExhausted({ form = null, toggleName = null, item, uses = null, prefix = "⚠️" } = {}) {
  if (!item) return;
  const u = uses || getItemUses(item);
  if (form?.length && toggleName) {
    try { form.find(`input[name="${toggleName}"]`).prop("checked", false); } catch {}
  }
  ui.notifications.warn(`${prefix} No te quedan usos de ${item.name} (${u.remaining}/${u.max}).`);
  if (form?.length) _refreshUsesUi(form, item, u);
}

function _clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
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
  const r = _clamp01(ratio);
  if (r >= 0.5) return _mixHex('#d97706', '#1f9d55', (r - 0.5) / 0.5);
  if (r >= 0.25) return _mixHex('#b91c1c', '#d97706', (r - 0.25) / 0.25);
  return _mixHex('#050505', '#b91c1c', r / 0.25);
}

function _decorateHp(hp) {
  const value = Math.max(0, safeNum(hp?.value, 0));
  const max = Math.max(0, safeNum(hp?.max, 0));
  const temp = Math.max(0, safeNum(hp?.temp, 0));
  const tempmax = Math.max(0, safeNum(hp?.tempmax, 0));
  const ratio = max > 0 ? _clamp01(value / max) : 0;
  return {
    value,
    max,
    temp,
    tempmax,
    fillStyle: `width:${Math.round(ratio * 1000) / 10}%; background:${_hpColorByRatio(ratio)};`,
    tempFillStyle: temp > 0 ? 'width:100%; background:rgba(31,157,85,.9);' : 'width:0%; background:transparent;',
    tempActive: temp > 0
  };
}

export class OLAttackApp extends LegacyApplication {
  constructor({ actor, token }) {
    super();
    this.actor = actor;
    this.token = token;

    this.state = foundry.utils.deepClone(game.settings.get(MODULE_ID, "windowState") || {});
    this.activeTab = this.state.tab || "main";
    this.selectedItemId = this.state.itemId || null;

    this._dirtyPrefs = false;
    this._allPrefs = {};
    this._prefsSaveTimer = null;
    this._prefsSaveDelay = 250;
    this._prefsSaveInFlight = null;
    this._windowStateSaveTimer = null;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "ol-attack-app",
      title: "OL Attack",
      template: "modules/ol-attack/templates/ol-attack-app.hbs",
      classes: ["ol-attack", "ol-window-theme"],
      width: 720,
      height: 720,
      minWidth: 620,
      minHeight: 520,
      resizable: true,
      minimizable: true
    });
  }

  async getData() {
    const actor = this.actor;
    const allAttackItems = getAttackItems(actor);

    let visibilityMap = (await actor.getFlag(FLAG_SCOPE, FLAG_VISIBLE)) || {};
    let offhandEnabled = (await actor.getFlag(FLAG_SCOPE, FLAG_OFFHAND_ENABLED)) || false;
    let offhandWeaponId = (await actor.getFlag(FLAG_SCOPE, FLAG_OFFHAND_WEAPON)) || null;
    let autoClose = (await actor.getFlag(FLAG_SCOPE, FLAG_AUTO_CLOSE)) !== false;

    const canConfigList = actor.isOwner || game.user.isGM;
    const features = getActorFeatures(actor);


    // Multiattack (PNJ): mostrar descripción completa del rasgo en la macro
    if (features?.hasMultiattack) {
      const mi = (features.multiattackItemId ? actor.items.get(features.multiattackItemId) : null)
        || actor.items?.find?.((i) => isMultiattackItem(i, actor))
        || actor.items?.contents?.find?.((i) => isMultiattackItem(i, actor));
      if (mi) {
        const raw = (gp(mi, "system.description.value") ?? gp(mi, "system.description") ?? "");
        let enriched = "";
        try {
          if (raw && globalThis.TextEditor?.enrichHTML) {
            enriched = await globalThis.TextEditor.enrichHTML(raw, {
              async: true,
              secrets: false,
              documents: true,
              relativeTo: actor
            });
          }
        } catch (e) {
          // Si falla el enriquecimiento, usamos el HTML original
          enriched = raw || "";
        }
        features.multiattack = {
          id: mi.id,
          name: mi.name,
          description: enriched || raw || ""
        };
      } else {
        features.multiattack = { id: null, name: "Multiataque", description: "" };
      }
    }

    const allItemsUnsorted = allAttackItems.filter(i => visibilityMap?.[i.id] !== false && !isItemHiddenByProfile(i, actor));
    const knownItemIds = new Set(allItemsUnsorted.map((i) => i.id));
    const readableFeatures = Array.from(actor.items?.contents || actor.items || [])
      .filter((i) => i?.type !== "spell" && i?.type !== "weapon")
      .filter((i) => !knownItemIds.has(i.id))
      .filter((i) => visibilityMap?.[i.id] !== false && !isItemHiddenByProfile(i, actor))
      .filter((i) => isMultiattackItem(i, actor) || String(gp(i, "system.description.value") || "").trim());

    const combatItems = allItemsUnsorted.filter(i => isCombatItem(i))
      .sort((a,b) => gp(a, "system.equipped") === gp(b, "system.equipped") ? a.name.localeCompare(b.name) : gp(a, "system.equipped") ? -1 : 1);

    const utilitySpells = allItemsUnsorted.filter(i => i.type === "spell" && !isCombatItem(i)).sort((a,b) => a.name.localeCompare(b.name));
    const utilityFeatures = [
      ...allItemsUnsorted.filter(i => i.type !== "spell" && i.type !== "weapon" && !isCombatItem(i)),
      ...readableFeatures
    ].sort((a, b) => a.name.localeCompare(b.name));

    // ============================
    // Agrupar conjuros por nivel (Trucos, Nivel 1..9)
    // ============================
    const groupSpellsByLevel = (spells = []) => {
      const map = new Map();
      for (let i = 0; i <= 9; i++) map.set(i, []);
      for (const sp of spells) {
        const lvl = Math.max(0, Math.min(9, Number(getSpellLevel(sp) || 0)));
        map.get(lvl).push(sp);
      }
      const out = [];
      for (const [lvl, arr] of map.entries()) {
        if (!arr.length) continue;
        arr.sort((a,b) => a.name.localeCompare(b.name));
        out.push({
          level: lvl,
          label: lvl === 0 ? "Trucos" : `Nivel ${lvl}`,
          items: arr
        });
      }
      return out;
    };

    const combatWeapons = combatItems.filter((i) => i.type === "weapon");
    const combatSpells = combatItems.filter((i) => i.type === "spell");
    const combatFeatures = combatItems.filter((i) => i.type !== "weapon" && i.type !== "spell");

    const combatSpellGroups = groupSpellsByLevel(combatSpells);
    const utilitySpellGroups = groupSpellsByLevel(utilitySpells);

    const equippedWeapons = getEquippedWeapons(actor);
    const offhandWeapon = offhandWeaponId ? actor.items.get(offhandWeaponId) : null;

    const hasMagic = hasMagicActor(actor) || utilitySpells.length > 0 || utilityFeatures.length > 0;
    if (!hasMagic && this.activeTab !== "main") this.activeTab = "main";

    this._allPrefs = await migrateUserPrefsToActorIfNeeded(actor);

    // Selección por estado/prefs
    let defaultItem = null;
    if (this.selectedItemId) {
      defaultItem = combatItems.find((i) => i.id === this.selectedItemId)
        || utilitySpells.find((i) => i.id === this.selectedItemId)
        || utilityFeatures.find((i) => i.id === this.selectedItemId);
    }
    if (!defaultItem && this._allPrefs.lastUsedItemId) {
      defaultItem = combatItems.find((i) => i.id === this._allPrefs.lastUsedItemId)
        || utilitySpells.find((i) => i.id === this._allPrefs.lastUsedItemId)
        || utilityFeatures.find((i) => i.id === this._allPrefs.lastUsedItemId);
    }
    if (!defaultItem) defaultItem = combatItems[0] || utilitySpells[0] || utilityFeatures[0];

    this.selectedItemId = defaultItem?.id ?? null;

const attachUses = (arr=[]) => {
  for (const it of arr) {
    const u = getItemUses(it);
    if (u.max > 0) it.olUses = { remaining: u.remaining, max: u.max };
  }
};
attachUses(combatItems);
attachUses(utilitySpells);
attachUses(utilityFeatures);

// Contadores destacados de recursos limitados (bardo, lucky, rabia, canalizar, etc.)
const specialCounters = _getSpecialCounters(actor);


    // Rasgos: dados extra por ítem (para rasgos/hechizos sin tirada)
    const rasgosExtraDiceMap = (await actor.getFlag(FLAG_SCOPE, FLAG_RASGOS_EXTRA_DICE)) || {};
    this._rasgosExtraDiceMap = foundry.utils.duplicate(rasgosExtraDiceMap);
    const markHasExtra = (arr=[]) => {
      for (const it of arr) {
        const ed = rasgosExtraDiceMap?.[it.id];
        it.olHasExtraDice = !!(ed && String(ed.formula||"").trim());
      }
    };
    markHasExtra(utilitySpells);
    markHasExtra(utilityFeatures);

    const _selectedExtra = rasgosExtraDiceMap?.[this.selectedItemId] || { formula: "", label: "", enabled: false };
    const rasgosExtraDice = {
      ..._selectedExtra,
      enabled: _selectedExtra?.enabled ?? !!String(_selectedExtra?.formula || "").trim()
    };

    const hp = _decorateHp(getActorHpData(actor));

    // Concentración (info para indicador)
    const concentration = await getConcentrationInfo(actor);

    const slots = getAvailableSpellSlots(actor);

    return {
      actor,
      token: this.token,
      hasMagic,
      activeTab: this.activeTab,
      canConfigList,
      features,
      offhandEnabled,
      offhandWeaponId,
      offhandWeapon,
      offhandWeaponDamageLabel: offhandWeapon ? getWeaponDamageType(offhandWeapon) : "bludgeoning",
      autoClose,
      combatItems,
      combatWeapons,
      combatSpellGroups,
      combatFeatures,
      utilitySpells,
      utilitySpellGroups,
      utilityFeatures,
      equippedWeapons,
      selectedItemId: this.selectedItemId,
      hp,
      slots,
      specialCounters,
      rasgosExtraDice,
      concentration,
      isGM: !!game.user?.isGM
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
        tab: this.activeTab,
        itemId: this.selectedItemId
      };
    } catch (_) {}
  }

  async _render(force=false, options={}) {
    // Capturamos primero la posición real actual para que un rerender no devuelva la ventana
    // a una posición antigua cuando el usuario ya la ha recolocado manualmente.
    this._snapshotWindowState();
    const st = this.state || {};
    if (!Number.isFinite(options.left) && Number.isFinite(st.left)) options.left = st.left;
    if (!Number.isFinite(options.top) && Number.isFinite(st.top)) options.top = st.top;
    if (!Number.isFinite(options.width) && Number.isFinite(st.width)) options.width = st.width;
    if (!Number.isFinite(options.height) && Number.isFinite(st.height)) options.height = st.height;
    return super._render(force, options);
  }

  setPosition(position = {}) {
    const out = super.setPosition(position);
    this._scheduleWindowStateSave();
    return out;
  }

  _scheduleWindowStateSave() {
    clearTimeout(this._windowStateSaveTimer);
    this._windowStateSaveTimer = setTimeout(() => {
      this._saveWindowState?.();
    }, 140);
  }

  async _saveWindowState() {
    try {
      this._snapshotWindowState();
      await game.settings.set(MODULE_ID, "windowState", this.state);
    } catch (_) {}
  }

  async _openActorContextMenu(point = {}) {
    closeOlContextMenu();
    const actor = this.actor;
    if (!actor) return;
    const token = this.token;
    const canTarget = !!token;
    const isTargeted = canTarget && Array.from(game.user?.targets || []).some((t) => String(t.id) === String(token.id));
    openOlContextMenu({
      x: safeNum(point.x, window.innerWidth / 2),
      y: safeNum(point.y, window.innerHeight / 2),
      title: actor.name || 'Actor',
      items: [
        ...(canTarget ? [{
          label: isTargeted ? 'Quitar objetivo' : 'Marcar objetivo',
          action: async () => {
            try {
              token.setTarget(!isTargeted, { user: game.user, releaseOthers: false, groupSelection: true });
            } catch (_) {}
          }
        }, { type: 'separator' }] : []),
        {
          label: 'Aplicar estado',
          action: async () => {
            await openStatusPicker({ actor, token, mode: 'apply', title: `Aplicar estado · ${actor.name}` });
          }
        },
        {
          label: 'Quitar estado',
          action: async () => {
            await openStatusPicker({ actor, token, mode: 'remove', title: `Quitar estado · ${actor.name}` });
          }
        }
      ]
    });
  }

  activateListeners(html) {
    super.activateListeners(html);

    const form = html.find("form#ol-form");
    const itemInput = form.find('input[name="itemId"]');

    const setTab = (t) => {
      this.activeTab = t;
      form.find(".ol-tab-btn").removeClass("active");
      form.find(`.ol-tab-btn[data-tab="${t}"]`).addClass("active");
      form.find(".ol-tab").removeClass("active");
      form.find(`.ol-tab[data-tab-panel="${t}"]`).addClass("active");
      this._persistWindowState();
      this._updatePreview(html);
      this._updateRasgosExtraDiceInputs(form);
    };

    form.on("click", ".ol-tab-btn", (ev) => {
      ev.preventDefault();
      setTab(String(ev.currentTarget.dataset.tab || "main"));
    });


// Click en contador destacado -> seleccionar ítem si existe en listas
form.on("click", ".ol-counter-chip", (ev) => {
  ev.preventDefault();
  const id = String(ev.currentTarget.dataset.id || "");
  if (!id) return;
  const btn = form.find(`.ol-weapon-btn[data-id="${id}"]`);
  if (btn.length) btn.trigger("click");
});

    form.on("click", ".ol-action-profiles", (ev) => {
      ev.preventDefault();
      if (!game.user?.isGM) return;
      game.olAttack?.openActionProfileConfig?.();
    });

    form.on("contextmenu", ".ol-root", async (ev) => {
      const interactiveSelector = '[data-action], button, input, select, textarea, a, label, .ol-weapon-btn, .ol-tab-btn, .ol-chip, .ol-counter-chip, .ol-hp-editable';
      if ($(ev.target).closest(interactiveSelector).length) return;
      ev.preventDefault();
      ev.stopPropagation();
      await this._openActorContextMenu({ x: ev.clientX, y: ev.clientY });
    });

    form.on("click", ".ol-weapon-btn", (ev) => {
      ev.preventDefault();
      const id = String(ev.currentTarget.dataset.id);
      this.selectedItemId = id;
      itemInput.val(id);
      form.find(".ol-weapon-btn").removeClass("selected");
      form.find(`.ol-weapon-btn[data-id="${id}"]`).addClass("selected");
      this._applyPrefsToForm(form, id);
      this._allPrefs.lastUsedItemId = id;
      this._queuePersistPrefs(id, { immediate: true });
      this._persistWindowState();
      this._updateSpellLevelOptions(form);
      this._updatePreview(html);
      this._updateRasgosExtraDiceInputs(form);
    });

    // Dependencias Rasgos/Extras
    // Frenesí solo puede usarse durante Furia: si se marca Frenesí, marcamos Furia obligatoriamente.
    // Además, bloqueamos el checkbox de Furia mientras Frenesí esté activo para evitar estados inválidos.
    const _syncFrenzyDeps = () => {
      const frenzy = form.find('input[name="useFrenzy"]');
      const rage = form.find('input[name="useRage"]');
      const isFrenzy = frenzy.is(":checked");
      if (isFrenzy) {
        if (!rage.is(":checked")) rage.prop("checked", true);
        rage.prop("disabled", true);
      } else {
        rage.prop("disabled", false);
      }
    };

    form.on("change", 'input[name="useFrenzy"]', () => {
      _syncFrenzyDeps();
      this._saveFormToPrefs(form);
      this._updatePreview(html);
      this._updateRasgosExtraDiceInputs(form);
    });

    form.on("change", 'input[name="useRage"]', () => {
      // Si intentan desmarcar Furia con Frenesí activo, apagamos Frenesí.
      const rage = form.find('input[name="useRage"]');
      const frenzy = form.find('input[name="useFrenzy"]');
      if (!rage.is(":checked") && frenzy.is(":checked")) frenzy.prop("checked", false);
      _syncFrenzyDeps();
      this._saveFormToPrefs(form);
      this._updatePreview(html);
      this._updateRasgosExtraDiceInputs(form);
    });

    // Hover-card: mantener 0.5s el ratón encima para ver “carta” del ítem
    form.on("mouseenter", ".ol-weapon-btn", (ev) => {
      const id = String(ev.currentTarget.dataset.id || "");
      if (!id) return;
      _olHoverLastItemId = id;
      _olHoverLastPos = { x: ev.clientX, y: ev.clientY };

      if (_olHoverTimer) clearTimeout(_olHoverTimer);
      if (_olHoverHideTimer) { clearTimeout(_olHoverHideTimer); _olHoverHideTimer = null; }

      _olHoverTimer = setTimeout(async () => {
        try {
          if (_olHoverPinned) return;
          if (_olHoverLastItemId !== id) return;

          const item = this.actor?.items?.get?.(id);
          if (!item) return;

          const reqId = ++_olHoverReq;
          const htmlCard = await _buildHoverCardHtml(item, this.actor);
          if (reqId !== _olHoverReq) return;

          const el = _ensureHoverCard();
          el.dataset.itemId = id;
          el.innerHTML = htmlCard;
          el.style.display = "block";
          _positionHoverCard(_olHoverLastPos.x, _olHoverLastPos.y);
        } catch (e) {
          console.warn("[ol-attack] hovercard error", e);
        }
      }, 500);
    });

    form.on("mousemove", ".ol-weapon-btn", (ev) => {
      _olHoverLastPos = { x: ev.clientX, y: ev.clientY };
      if (_olHoverCardEl && _olHoverCardEl.style.display !== "none" && !_olHoverPinned) {
        const id = String(ev.currentTarget.dataset.id || "");
        if (_olHoverCardEl.dataset.itemId === id) _positionHoverCard(_olHoverLastPos.x, _olHoverLastPos.y);
      }
    });

    form.on("mouseleave", ".ol-weapon-btn", () => {
      if (_olHoverTimer) { clearTimeout(_olHoverTimer); _olHoverTimer = null; }
      _scheduleHideHoverCard(120);
    });


    form.on("change input", "select, input", () => {
      this._saveFormToPrefs(form);
      this._updatePreview(html);
    });

    html.find(".ol-gear").on("click", async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const changed = await openVisibilityConfig({ actor: this.actor });
      if (changed) this.render(true);
    });

    html.find(".ol-mini-tool[data-action]").on("click", async (ev) => {
      ev.preventDefault();
      const action = String(ev.currentTarget.dataset.action || "");
      await this._handleHeaderAction(action);
    });

    // Botones de acción
    form.find(".ol-btn[data-mode]").not("#ol-btn-cast-magic").on("click", async (ev) => {
      ev.preventDefault();
      const mode = String(ev.currentTarget.dataset.mode || "normal");
      await this._resolveAction({ mode, isOffhand: false });
    });

    form.find(".ol-offhand-attack-btn").on("click", async (ev) => {
      ev.preventDefault();
      await this._resolveAction({ mode: "normal", isOffhand: true });
    });

    form.find("#ol-btn-cast-magic").on("click", async (ev) => {
      ev.preventDefault();
      await this._resolveAction({ mode: "normal", isOffhand: false, forceMagicTab: true });
    });

    // Rasgos: guardar dados extra por ítem (manual roll para EFECTO)
    const saveRasgosExtraDice = async () => {
      const id = String(form.find('input[name="itemId"]').val() || "");
      if (!id) return;
      const enabled = form.find('input[name="enableRasgosExtraDice"]').is(":checked");
      const formula = sanitizeFormulaLoose(form.find('input[name="rasgosExtraDiceFormula"]').val() || "");
      const label = String(form.find('input[name="rasgosExtraDiceLabel"]').val() || "").trim();
      let map = (await this.actor.getFlag(FLAG_SCOPE, FLAG_RASGOS_EXTRA_DICE)) || {};
      map = foundry.utils.duplicate(map);
      if (!enabled && !formula && !label) {
        delete map[id];
      } else {
        map[id] = { enabled, formula, label };
      }
      await this.actor.setFlag(FLAG_SCOPE, FLAG_RASGOS_EXTRA_DICE, map);
      this._rasgosExtraDiceMap = foundry.utils.duplicate(map);
      this._updateRasgosExtraDiceInputs(form, id);
      // actualizar badges visuales sin rerender completo
      try {
        form.find(`.ol-weapon-btn[data-id="${id}"] .ol-mini-badge`).remove();
        if (formula) form.find(`.ol-weapon-btn[data-id="${id}"]`).append(`<span class="ol-mini-badge" title="Tiene dados extra">🎲</span>`);
      } catch {}
    };

    form.on("change", 'input[name="enableRasgosExtraDice"]', saveRasgosExtraDice);
    form.on("change", 'input[name="rasgosExtraDiceFormula"]', saveRasgosExtraDice);
    form.on("change", 'input[name="rasgosExtraDiceLabel"]', saveRasgosExtraDice);
    form.on("blur", 'input[name="rasgosExtraDiceFormula"]', saveRasgosExtraDice);
    form.on("blur", 'input[name="rasgosExtraDiceLabel"]', saveRasgosExtraDice);

    // Concentración: limpiar flag desde el indicador
    form.on("click", ".ol-conc-clear", async (ev) => {
      ev.preventDefault();
      await this.actor.unsetFlag(FLAG_SCOPE, FLAG_CONCENTRATION);
      this.render(false);
    });


    // Buscar magia
    form.on("input", ".ol-magic-search", (ev) => {
      const q = String(ev.currentTarget.value || "").toLowerCase().trim();
      form.find(".ol-magic-list .ol-weapon-btn").each((_, el) => {
        const id = String(el.dataset.id || "");
        const it = this.actor.items.get(id);
        const nm = String(it?.name || "").toLowerCase();
        el.style.display = (!q || nm.includes(q)) ? "" : "none";
      });
    });

    form.on("dblclick", '[data-action="edit-hp"]', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await this._promptSetActorHp();
    });

    // Initial
    this._applyPrefsToForm(form, this.selectedItemId);
    _syncFrenzyDeps();
    this._updateSpellLevelOptions(form);
    this._renderSlots(form);
    this._updatePreview(html);
    this._updateRasgosExtraDiceInputs(form);

    // Keybinds (Enter)
    const ns = ".olattack_key";
    const cleanup = () => $(document).off(`keydown${ns}`);
    Hooks.once("closeOLAttackApp", cleanup);
    $(document).on(`keydown${ns}`, (e) => {
      const rootEl = html?.[0];
      if (!rootEl || !document.body.contains(rootEl)) return cleanup();
      const tag = document.activeElement?.tagName?.toUpperCase?.() || "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) return this._resolveAction({ mode: "adv", isOffhand: false });
        if (e.altKey) return this._resolveAction({ mode: "dis", isOffhand: false });
        return this._resolveAction({ mode: "normal", isOffhand: false });
      }
    });
  }

  async close(options) {
    clearTimeout(this._windowStateSaveTimer);
    await this._saveWindowState();
    await this._flushPrefsPersistence();
    return super.close(options);
  }

  _persistWindowState() {
    this._saveWindowState?.();
  }

  _getSelectedItemId(form) {
    return String(form.find('input[name="itemId"]').val() || this.selectedItemId || "");
  }

  async _persistPrefsNow(itemId = null) {
    const id = String(itemId || this.selectedItemId || "").trim();
    if (!id) return;
    const config = foundry.utils.duplicate(this._allPrefs?.[id] || {});
    this._prefsSaveInFlight = saveActorPrefs(this.actor, id, config, this._allPrefs)
      .then((saved) => {
        this._allPrefs = saved || this._allPrefs;
        this._dirtyPrefs = false;
      })
      .catch((err) => {
        console.warn('[ol-attack] Error guardando preferencias automáticas', err);
      })
      .finally(() => {
        this._prefsSaveInFlight = null;
      });
    await this._prefsSaveInFlight;
  }

  _queuePersistPrefs(itemId = null, { immediate = false } = {}) {
    const id = String(itemId || this.selectedItemId || "").trim();
    if (!id) return;
    if (this._prefsSaveTimer) {
      clearTimeout(this._prefsSaveTimer);
      this._prefsSaveTimer = null;
    }
    if (immediate) {
      this._persistPrefsNow(id);
      return;
    }
    this._prefsSaveTimer = setTimeout(() => {
      this._prefsSaveTimer = null;
      this._persistPrefsNow(id);
    }, Math.max(0, Number(this._prefsSaveDelay) || 250));
  }

  async _flushPrefsPersistence() {
    if (this._prefsSaveTimer) {
      clearTimeout(this._prefsSaveTimer);
      this._prefsSaveTimer = null;
      const id = String(this.selectedItemId || this._allPrefs?.lastUsedItemId || "").trim();
      if (id) await this._persistPrefsNow(id);
      return;
    }
    if (this._prefsSaveInFlight) await this._prefsSaveInFlight;
  }

  _updateRasgosExtraDiceInputs(form, itemId = null) {
    const block = form.find('.ol-rasgos-extra-block');
    const wrap = form.find('.ol-rasgos-extra-wrap');
    const toggle = form.find('input[name="enableRasgosExtraDice"]');
    if (!block.length || !wrap.length || !toggle.length) return;

    const id = String(itemId || this._getSelectedItemId(form) || "");
    const item = this.actor?.items?.get?.(id) || null;
    const supports = !!item && item.type !== 'weapon';

    block.toggleClass('is-hidden', !supports);
    if (!supports) {
      toggle.prop('checked', false);
      form.removeClass('ol-rasgos-extra-enabled');
      wrap.hide();
      return;
    }

    const extra = this._rasgosExtraDiceMap?.[id] || { formula: '', label: '', enabled: false };
    form.find('input[name="rasgosExtraDiceFormula"]').val(String(extra.formula || ''));
    form.find('input[name="rasgosExtraDiceLabel"]').val(String(extra.label || ''));
    const enabled = extra?.enabled ?? !!String(extra.formula || '').trim();
    toggle.prop('checked', enabled);
    form.toggleClass('ol-rasgos-extra-enabled', enabled);
    wrap.toggle(enabled);
  }

  async _handleHeaderAction(action) {
    if (action === 'initiative') return this._rollInitiativeFromMacro();
    if (action === 'death-save') return this._rollDeathSaveFromMacro();
    if (action === 'short-rest') return this._executeRest('short');
    if (action === 'long-rest') return this._executeRest('long');
    if (action === 'scene-monitor') return game.olAttack?.openSceneTracker?.();
  }

  _getCombatToken() {
    if (this.token?.document) return this.token;
    const controlled = canvas?.tokens?.controlled?.find((t) => t.actor?.id === this.actor?.id);
    if (controlled) return controlled;
    const placeable = canvas?.tokens?.placeables?.find((t) => t.actor?.id === this.actor?.id);
    return placeable || null;
  }

  async _rollInitiativeFromMacro() {
    const tok = this._getCombatToken();
    if (!tok?.document && !tok?.id) {
      ui.notifications.warn('⚠️ Necesitas un token del actor en la escena para tirar iniciativa.');
      return;
    }
    const tokenDoc = tok.document || tok;
    let combat = game.combat;
    if (!combat) {
      combat = await Combat.create({ scene: canvas.scene?.id, active: true });
    }
    let combatant = combat.combatants.find((c) => c.tokenId === tokenDoc.id);
    if (!combatant) {
      const created = await combat.createEmbeddedDocuments('Combatant', [{ tokenId: tokenDoc.id, actorId: this.actor.id, hidden: !!tokenDoc.hidden }]);
      combatant = created?.[0] || combat.combatants.find((c) => c.tokenId === tokenDoc.id);
    }
    if (!combatant) return ui.notifications.warn('⚠️ No se pudo crear el combatiente para la iniciativa.');
    await combat.rollInitiative([combatant.id]);
    ui.notifications.info(`🎲 Iniciativa tirada para ${this.actor.name}.`);
  }

  async _rollDeathSaveFromMacro() {
    const actor = this.actor;
    if (!actor) return;
    const hp = safeNum(getActorHpData(actor).value, 0);
    if (hp > 0) {
      ui.notifications.warn(`⚠️ ${actor.name} no está a 0 PG; no corresponde tirar salvación de muerte.`);
      return;
    }

    const attempts = [
      async () => actor.rollDeathSave?.({ chatMessage: true }),
      async () => actor.rollDeathSave?.(),
      async () => actor.sheet?._onRollDeathSave?.(new Event('click')),
      async () => actor.sheet?._onDeathSave?.(new Event('click'))
    ];

    for (const fn of attempts) {
      try {
        const out = await fn();
        if (out !== false && out !== undefined) {
          ui.notifications.info(`💀 Salvación de muerte tirada para ${actor.name}.`);
          this.render(true);
          return out;
        }
      } catch {}
    }

    ui.notifications.warn('⚠️ No se pudo ejecutar la salvación de muerte desde la macro con esta versión del sistema.');
  }

  async _executeRest(kind = 'short') {
    const actor = this.actor;
    const isLong = kind === 'long';
    const label = isLong ? 'descanso largo' : 'descanso corto';

    const attempts = isLong
      ? [
          async () => actor.longRest?.({ dialog: false }),
          async () => actor.longRest?.(),
          async () => actor.sheet?._onLongRest?.(new Event('click'))
        ]
      : [
          async () => actor.shortRest?.({ dialog: false }),
          async () => actor.shortRest?.(),
          async () => actor.sheet?._onShortRest?.(new Event('click'))
        ];

    for (const fn of attempts) {
      try {
        const out = await fn();
        if (out !== false) {
          ui.notifications.info(`🛌 ${this.actor.name}: ${label} realizado.`);
          this.render(true);
          return out;
        }
      } catch {}
    }

    ui.notifications.warn(`⚠️ No se pudo ejecutar el ${label} desde la macro con esta versión del sistema.`);
  }

  async _promptSetActorHp() {
    const actor = this.actor;
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
            callback: async (html) => {
              const raw = html.find('input[name="hpValue"]').val();
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

  _applyPrefsToForm(form, id) {
    const p = this._allPrefs?.[id] || {};
    if (p.systemMode) form.find('select[name="systemMode"]').val(p.systemMode);
    if (p.ability) form.find('select[name="ability"]').val(p.ability);
    if (p.dmgMode) form.find('select[name="dmgMode"]').val(p.dmgMode);
    if (p.prof !== undefined) form.find('input[name="prof"]').prop("checked", !!p.prof);
    if (p.temp !== undefined) form.find('input[name="temp"]').val(String(p.temp));
    if (p.manualFormula !== undefined) form.find('input[name="manualFormula"]').val(String(p.manualFormula));
    if (p.useExtraDice !== undefined) form.find('input[name="useExtraDice"]').prop("checked", !!p.useExtraDice);
    if (p.extraDiceFormula !== undefined) form.find('input[name="extraDiceFormula"]').val(String(p.extraDiceFormula || ""));
    if (p.extraDiceLabel !== undefined) form.find('input[name="extraDiceLabel"]').val(String(p.extraDiceLabel || ""));
    if (p.offhandFormula !== undefined) form.find('input[name="offhandFormula"]').val(String(p.offhandFormula || "1d6"));

    if (p.useRage !== undefined) form.find('input[name="useRage"]').prop("checked", !!p.useRage);
    if (p.useReckless !== undefined) form.find('input[name="useReckless"]').prop("checked", !!p.useReckless);
    if (p.useFrenzy !== undefined) form.find('input[name="useFrenzy"]').prop("checked", !!p.useFrenzy);
    if (p.useSneak !== undefined) form.find('input[name="useSneak"]').prop("checked", !!p.useSneak);
    if (p.useSavage !== undefined) form.find('input[name="useSavage"]').prop("checked", !!p.useSavage);
    if (p.useWails !== undefined) form.find('input[name="useWails"]').prop("checked", !!p.useWails);

    this._toggleExtra(form);
  }

  _toggleExtra(form) {
    const on = form.find('input[name="useExtraDice"]').is(":checked");
    form.toggleClass("ol-extra-enabled", on);
    form.find("#ol-extra-wrap").toggle(on);
  }

  _saveFormToPrefs(form) {
    const id = String(form.find('input[name="itemId"]').val());
    const getBool = (sel) => form.find(sel).is(":checked");
    this._allPrefs[id] = {
      systemMode: form.find('select[name="systemMode"]').val(),
      ability: form.find('select[name="ability"]').val(),
      dmgMode: form.find('select[name="dmgMode"]').val(),
      prof: getBool('input[name="prof"]'),
      temp: safeNum(form.find('input[name="temp"]').val(), 0),
      manualFormula: form.find('input[name="manualFormula"]').val() || "0",
      useExtraDice: getBool('input[name="useExtraDice"]'),
      extraDiceFormula: form.find('input[name="extraDiceFormula"]').val() || "",
      extraDiceLabel: form.find('input[name="extraDiceLabel"]').val() || "",
      offhandFormula: form.find('input[name="offhandFormula"]').val() || "1d6",
      useRage: getBool('input[name="useRage"]'),
      useReckless: getBool('input[name="useReckless"]'),
      useFrenzy: getBool('input[name="useFrenzy"]'),
      useSneak: getBool('input[name="useSneak"]'),
      useSavage: getBool('input[name="useSavage"]'),
      useWails: getBool('input[name="useWails"]')
    };
    this._allPrefs.lastUsedItemId = id;
    this._dirtyPrefs = true;
    this._toggleExtra(form);
    this._queuePersistPrefs(id);
  }

  _renderSlots(form) {
    const wrap = form.find(".ol-slot-wrap");
    if (!wrap.length) return;
    const slots = getAvailableSpellSlots(this.actor);
    if (!slots.length) {
      wrap.html(`<div style="color:#888; font-size:12px;">(Este actor no tiene espacios de conjuro configurados)</div>`);
      return;
    }
    wrap.html(slots.map((s) => {
      const used = Math.max(0, safeNum(s.max, 0) - safeNum(s.value, 0));
      const lvlTxt = s.key === "pact" ? `Pacto (Nv.${s.level})` : `Nivel ${s.level}`;
      return `<div class="ol-slot-row" data-level="${s.level}" data-key="${s.key}">
        <div style="min-width:0;">
          <div class="ol-slot-name">${escapeHtml(lvlTxt)}</div>
          <div class="ol-slot-meta">Disponibles: <b>${s.value}</b> / ${s.max} · Usados: <b>${used}</b></div>
        </div>
      </div>`;
    }).join(""));

    // click para seleccionar nivel (en el selector activo)
    form.off("click.olslots").on("click.olslots", ".ol-slot-row", (ev) => {
      const row = ev.currentTarget;
      const level = parseInt(row.dataset.level);
      const key = String(row.dataset.key || "");
      const isMagicTab = form.find(".ol-tab[data-tab-panel='magic']").hasClass("active");
      const targetSelect = isMagicTab ? form.find('select[name="magicSpellLevel"]') : form.find('select[name="spellLevel"]');

      let picked = null;
      targetSelect.find("option").each((_, o) => {
        const lv = parseInt(o.value);
        const k = $(o).data("key");
        if (lv === level && (k === key || !picked)) picked = o;
      });
      if (picked) {
        targetSelect.val(String(picked.value));
        this._saveFormToPrefs(form);
        this._updatePreview(form.closest(".app"));
      }
    });
  }

  _updateSpellLevelOptions(form) {
    const id = String(form.find('input[name="itemId"]').val());
    const item = this.actor.items.get(id);
    const spellSection = form.find("#ol-spell-config");
    const spellLevelIn = form.find('select[name="spellLevel"]');
    const magicSpellLevelIn = form.find('select[name="magicSpellLevel"]');

    if (!item || item.type !== "spell") {
      spellSection.removeClass("active");
      return;
    }

    const baseLevel = getSpellLevel(item);
    const slots = getAvailableSpellSlots(this.actor);

    const buildOptions = (selectEl) => {
      selectEl.empty();
      if (baseLevel <= 0) {
        selectEl.append(`<option value="0" data-key="">Cantrip</option>`);
        return;
      }
      selectEl.append(`<option value="${baseLevel}" data-key="spell${baseLevel}">Base (Nivel ${baseLevel})</option>`);
      slots.forEach((slot) => {
        if (slot.level >= baseLevel && slot.value > 0) {
          selectEl.append(`<option value="${slot.level}" data-key="${slot.key}">${escapeHtml(slot.label)}</option>`);
        }
      });
    };

    if (spellLevelIn.data("item-id") !== id) { buildOptions(spellLevelIn); spellLevelIn.data("item-id", id); }
    if (magicSpellLevelIn.data("item-id") !== id) { buildOptions(magicSpellLevelIn); magicSpellLevelIn.data("item-id", id); }

    spellSection.addClass("active");
  }

  async _updatePreview(html) {
    const form = $(html).find("form#ol-form");
    if (!form.length) return;

    const preview = form.find("#ol-preview-text");
    const id = String(form.find('input[name="itemId"]').val());
    const item = this.actor.items.get(id);
    if (!item) { preview.text("—"); return; }

    const systemMode = form.find('select[name="systemMode"]').val();
    const isHomebrew = systemMode === "homebrew";

    const dmgMode = form.find('select[name="dmgMode"]').val();
    const isManual = dmgMode === "manual";
    form.toggleClass("ol-manual-mode", isManual);

    const ability = form.find('select[name="ability"]').val();
    const prof = form.find('input[name="prof"]').is(":checked");
    const temp = safeNum(form.find('input[name="temp"]').val(), 0);

    // Extras/rasgos (para reflejar en preview)
    const applyRage = isHomebrew && form.find('input[name="useRage"]').is(":checked");
    const applyFrenzy = isHomebrew && form.find('input[name="useFrenzy"]').is(":checked");
    const applySneak = isHomebrew && form.find('input[name="useSneak"]').is(":checked");

    const useExtra = form.find('input[name="useExtraDice"]').is(":checked");
    const extraDice = useExtra ? cleanDiceBonus(form.find('input[name="extraDiceFormula"]').val()) : "";
    const extraLabel = useExtra ? (form.find('input[name="extraDiceLabel"]').val() || "").trim() : "";

    // Spell cast level
    const isSpell = item.type === "spell";
    const activeSelect = form.find(".ol-tab[data-tab-panel='magic']").hasClass("active")
      ? form.find('select[name="magicSpellLevel"]')
      : form.find('select[name="spellLevel"]');

    let castLevel = getSpellLevel(item);
    if (isSpell && activeSelect.length) castLevel = safeNum(parseInt(activeSelect.val()), castLevel);

    let baseTxt = "";
    if (isManual) baseTxt = form.find('input[name="manualFormula"]').val() || "0";
    else {
      const parts = getDamagePartsDetailed(item, { abilityMod: 0, upcastLevel: castLevel });
      const heals = getHealingPartsDetailed(item, { upcastLevel: castLevel });
      if (parts.length) baseTxt = parts[0].formula;
      else if (heals.length) baseTxt = heals[0].formula;
      else baseTxt = isSpell ? "Sin daño" : "Sin daño";
    }

    const mods = [];
    if (isHomebrew) {
      const abilitySel = form.find('select[name="ability"]').val();
      const isSpellItem = item?.type === "spell";
      if (!isManual && abilitySel !== "none" && !(isSpellItem && abilitySel === "auto")) mods.push("+MOD");
      if (prof) mods.push("+PROF");

      // Rasgos/Extras en fórmula (para que se vean al seleccionar)
      const feats = getActorFeatures(this.actor);
      if (applyRage) mods.push(`+${safeNum(feats.rageBonus, 0)} (Furia)`);
      if (applyFrenzy) mods.push(`+2d6 (Frenesí)`);
      if (applySneak && feats.sneakFormula && feats.sneakFormula !== "0") mods.push(`+${feats.sneakFormula} (Furtivo)`);

      // Cansancio apilable / penalización
      const ex = getExhaustionInfo(this.actor);
      if (ex.level > 0 && ex.penalty > 0) mods.push(`-${ex.penalty} (Cansancio ${ex.level})`);

      // Bonos/penalizadores de estados (solo numéricos para preview)
      const rawBonus = String(getActorDamageBonusFormula(this.actor, item) || "").trim();
      if (rawBonus && /^[0-9+\-*/().\s]+$/.test(rawBonus) && rawBonus !== "0") {
        mods.push(`+(${rawBonus}) (Estados)`);
      }
    }
    if (temp) mods.push(temp >= 0 ? `+${temp}` : `${temp}`);

    let extraTxt = "";
    if (useExtra && extraDice) extraTxt = ` + ${extraDice}${extraLabel ? ` (${extraLabel})` : " (Dados extra)"}`;
    const baseSpellLevel = getSpellLevel(item);
    if (isSpell && castLevel > baseSpellLevel) extraTxt += ` <span style="color:#9b59b6;">(Upcast Nv.${castLevel})</span>`;

    preview.html(`Fórmula: <b>${escapeHtml(baseTxt)} ${escapeHtml(mods.join(" "))}${extraTxt}</b>`);
  }

  async _resolveAction({ mode, isOffhand, forceMagicTab=false }) {
    const actor = this.actor;
    const token = this.token;
    const html = this.element;
    const form = html.find("form#ol-form");
    if (!form.length) return;

    const itemId = String(form.find('input[name="itemId"]').val());
    const item = isOffhand ? null : actor.items.get(itemId);
    const autoClose = (await actor.getFlag(FLAG_SCOPE, FLAG_AUTO_CLOSE)) !== false;

    // Guardar prefs
    this._saveFormToPrefs(form);
    await saveActorPrefs(actor, isOffhand ? "offhand" : itemId, this._allPrefs[isOffhand ? "offhand" : itemId] ?? {}, this._allPrefs);

    const selectedItemUse = (!isOffhand && item) ? _getLimitedUseState(item) : { limited: false, exhausted: false, uses: { max: 0, remaining: 0 } };
    if (!isOffhand && item && selectedItemUse.exhausted) {
      _warnLimitedUseExhausted({ form, item, uses: selectedItemUse.uses });
      this._saveFormToPrefs(form);
      return;
    }

    const resolvedActionProfile = (!isOffhand && item) ? resolveActionProfile(item, actor) : null;
    if (!isOffhand && item && isChoiceModeItem(item, actor)) {
      const explicitTargets = Array.from(game.user?.targets ?? []).map((t) => t.document?.uuid).filter(Boolean);
      let choiceSpellLevel = 0;
      let choiceSlotKey = null;
      let choiceConsumeSlot = false;
      if (item?.type === "spell") {
        const isMagicTab = forceMagicTab || form.find(".ol-tab[data-tab-panel='magic']").hasClass("active");
        const spellLevelSel = isMagicTab ? form.find('select[name="magicSpellLevel"]') : form.find('select[name="spellLevel"]');
        choiceSpellLevel = safeNum(parseInt(spellLevelSel.val()), getSpellLevel(item));
        choiceSlotKey = spellLevelSel.find(":selected").data("key") || null;
        choiceConsumeSlot = isMagicTab ? form.find('input[name="magicConsumeSlot"]').is(":checked") : form.find('input[name="consumeSlot"]').is(":checked");
      }
      await postChoiceModeCard({ actor, token, item, targetUuids: explicitTargets, profile: resolvedActionProfile?.profile || null, spellLevel: choiceSpellLevel, slotKey: choiceSlotKey, consumeSlot: choiceConsumeSlot });
      this._persistWindowState();
      if (autoClose) this.close();
      else this.render(true);
      return;
    }

    // Slot de conjuro
    if (item && item.type === "spell") {
      const isMagicTab = forceMagicTab || form.find(".ol-tab[data-tab-panel='magic']").hasClass("active");

    // Rasgos: dados extra por ítem (solo se usan en la pestaña RASGOS para rasgos/hechizos sin tirada)
    const rasgosExtraDiceMap = (await actor.getFlag(FLAG_SCOPE, FLAG_RASGOS_EXTRA_DICE)) || {};
    this._rasgosExtraDiceMap = foundry.utils.duplicate(rasgosExtraDiceMap);
    const rasgosExtra = (isMagicTab && item) ? (rasgosExtraDiceMap?.[item.id] || null) : null;
    const rasgosExtraEnabled = !!(rasgosExtra && (rasgosExtra.enabled ?? !!String(rasgosExtra.formula || "").trim()));
    const rasgosExtraFormula = rasgosExtraEnabled ? sanitizeFormulaLoose(rasgosExtra.formula || "") : "";
    const rasgosExtraLabel = rasgosExtraEnabled ? String(rasgosExtra.label || "").trim() : "";
      const consume = isMagicTab ? form.find('input[name="magicConsumeSlot"]').is(":checked") : form.find('input[name="consumeSlot"]').is(":checked");
      const spellLevelSel = isMagicTab ? form.find('select[name="magicSpellLevel"]') : form.find('select[name="spellLevel"]');
      const spellLevel = safeNum(parseInt(spellLevelSel.val()), getSpellLevel(item));
      const slotKey = spellLevelSel.find(":selected").data("key");

      const consumeSlotDecision = resolvedActionProfile?.profile ? shouldConsumeSpellSlotForProfile(resolvedActionProfile.profile) : undefined;
      if (consume && spellLevel > 0 && consumeSlotDecision !== false) {
        const res = await consumeSpellSlot(actor, slotKey);
        if (res.ok) ui.notifications.info(`🔮 Espacio gastado (${slotKey === "pact" ? "Pacto" : String(slotKey).replace("spell","Nivel ")}). Restantes: ${res.remaining}`);
        else ui.notifications.warn("⚠️ No te quedaban espacios para gastar (pero el lanzamiento se realizó).");
      }
    }

    const systemMode = form.find('select[name="systemMode"]').val();
    const ability = form.find('select[name="ability"]').val();
    const dmgMode = form.find('select[name="dmgMode"]').val();
    const prof = form.find('input[name="prof"]').is(":checked");
    const temp = safeNum(form.find('input[name="temp"]').val(), 0);

    let applyRage = form.find('input[name="useRage"]').is(":checked");
    let applyReckless = form.find('input[name="useReckless"]').is(":checked");
    let applyFrenzy = form.find('input[name="useFrenzy"]').is(":checked");
    let applySneak = form.find('input[name="useSneak"]').is(":checked");
    let applySavage = form.find('input[name="useSavage"]').is(":checked");
    let applyWails = form.find('input[name="useWails"]').is(":checked");

    const useExtraDice = form.find('input[name="useExtraDice"]').is(":checked");
    const extraDiceFormula = cleanDiceBonus(form.find('input[name="extraDiceFormula"]').val());
    const extraDiceLabel = (form.find('input[name="extraDiceLabel"]').val() || "").trim();

    const offhandFormula = form.find('input[name="offhandFormula"]').val() || "1d6";

    // Spell level
    const isMagicTab = forceMagicTab || form.find(".ol-tab[data-tab-panel='magic']").hasClass("active");

    // Rasgos: dados extra por ítem (solo se usan en la pestaña RASGOS para rasgos/hechizos sin tirada)
    const rasgosExtraDiceMap = (await actor.getFlag(FLAG_SCOPE, FLAG_RASGOS_EXTRA_DICE)) || {};
    this._rasgosExtraDiceMap = foundry.utils.duplicate(rasgosExtraDiceMap);
    const rasgosExtra = (isMagicTab && item) ? (rasgosExtraDiceMap?.[item.id] || null) : null;
    const rasgosExtraEnabled = !!(rasgosExtra && (rasgosExtra.enabled ?? !!String(rasgosExtra.formula || "").trim()));
    const rasgosExtraFormula = rasgosExtraEnabled ? sanitizeFormulaLoose(rasgosExtra.formula || "") : "";
    const rasgosExtraLabel = rasgosExtraEnabled ? String(rasgosExtra.label || "").trim() : "";
    const spellLevelSel = isMagicTab ? form.find('select[name="magicSpellLevel"]') : form.find('select[name="spellLevel"]');
    const spellLevel = safeNum(parseInt(spellLevelSel.val()), getSpellLevel(item));
    const baseLevel = getSpellLevel(item);
    const castLevelUp = item?.type === "spell" && spellLevel > baseLevel;

    // Nombre y desc
    const rollTitle = isOffhand ? "Ataque con Mano Débil" : item?.name ?? "Acción";
    const descriptionHtml = (!isOffhand && item) ? await enrichDescription(item, actor) : "";

    // Offhand dmg type from configured weapon
    let offhandDamageType = "bludgeoning";
    const offhandWeaponId = await actor.getFlag(FLAG_SCOPE, FLAG_OFFHAND_WEAPON);
    const offhandWeapon = offhandWeaponId ? actor.items.get(offhandWeaponId) : null;
    if (offhandWeapon) offhandDamageType = getWeaponDamageType(offhandWeapon);

    const features = getActorFeatures(actor);
    const pendingFeatureConsumes = [];

    const queueFeatureConsume = (kind, toggleName, { autoUncheck = true } = {}) => {
      const featureItem = kind === "wails"
        ? (features.wailsItemId ? actor.items.get(features.wailsItemId) : _findFeatureItem(actor, "wails"))
        : _findFeatureItem(actor, kind);
      if (!featureItem) return null;
      const uses = getItemUses(featureItem);
      if (uses.max <= 0) return null;
      if (uses.remaining <= 0) {
        try {
          _warnLimitedUseExhausted({ form, toggleName, item: featureItem, uses });
          this._saveFormToPrefs(form);
        } catch {}
        return { blocked: true, item: featureItem, uses };
      }
      pendingFeatureConsumes.push({ kind, toggleName, item: featureItem, autoUncheck });
      return { blocked: false, item: featureItem, uses };
    };

    const limitedFeatureChecks = [
      { enabled: applyRage, set: (v) => { applyRage = v; }, kind: "rage", toggleName: "useRage", autoUncheck: true },
      { enabled: applyReckless, set: (v) => { applyReckless = v; }, kind: "reckless", toggleName: "useReckless", autoUncheck: true },
      { enabled: applyFrenzy, set: (v) => { applyFrenzy = v; }, kind: "frenzy", toggleName: "useFrenzy", autoUncheck: true },
      { enabled: applySneak, set: (v) => { applySneak = v; }, kind: "sneak", toggleName: "useSneak", autoUncheck: true },
      { enabled: applySavage, set: (v) => { applySavage = v; }, kind: "savage", toggleName: "useSavage", autoUncheck: true },
      { enabled: applyWails, set: (v) => { applyWails = v; }, kind: "wails", toggleName: "useWails", autoUncheck: true }
    ];

    for (const checkDef of limitedFeatureChecks) {
      if (!checkDef.enabled) continue;
      const featureCheck = queueFeatureConsume(checkDef.kind, checkDef.toggleName, { autoUncheck: checkDef.autoUncheck });
      if (featureCheck?.blocked) checkDef.set(false);
    }

    let applyFrenzyFinal = applyFrenzy;
    if (applyFrenzyFinal && !applyRage) {
      applyFrenzyFinal = false;
      try {
        form.find('input[name="useFrenzy"]').prop("checked", false);
        this._saveFormToPrefs(form);
      } catch {}
      ui.notifications.warn('⚠️ Frenesí no puede aplicarse porque Furia/Rabia no tiene usos disponibles.');
    }

    const opts = {
      mode: applyReckless ? "adv" : mode,
      systemMode,
      ability,
      dmgMode,
      prof,
      temp,
      manualFormula: form.find('input[name="manualFormula"]').val() || "0",

      isOffhand,
      offhandFormula,
      offhandDamageType,
      itemImg: isOffhand ? (offhandWeapon?.img || "icons/weapons/daggers/dagger-simple.webp") : (item?.img || "icons/svg/sword.svg"),
      itemName: isOffhand ? (offhandWeapon ? `${offhandWeapon.name} (Mano Débil)` : "Ataque con Mano Débil") : (item?.name || "Acción"),
      rollTitle: isOffhand ? (offhandWeapon ? `${offhandWeapon.name} (Mano Débil)` : "Ataque con Mano Débil") : rollTitle,
      descriptionHtml,
      showDescription: !isOffhand,
      showSaves: !isOffhand,
      spellLevel,
      castLevelUp,

      // extras
      applyRage: applyRage && systemMode === "homebrew",
      applyReckless,
      applyFrenzy: applyFrenzyFinal && systemMode === "homebrew",
      applySneak,
      applySavage,
      applyWails,
      applyExtraDice: useExtraDice && !!extraDiceFormula,
      extraDiceFormula,
      extraDiceLabel,

      // Rasgos tab manual roll
      effectExtraDiceFormula: rasgosExtraFormula,
      effectExtraDiceLabel: rasgosExtraLabel,


      // needed values for workflow
      rageBonus: features.rageBonus,
      sneakFormula: features.sneakFormula,
      resolvedActionProfile: resolvedActionProfile?.profile || null
    };

    const originalTargets = Array.from(game.user?.targets ?? []);

    const result = await runAction({ actor, token, item: isOffhand ? offhandWeapon : item, opts });

    const consumeUsesDecision = resolvedActionProfile?.profile ? shouldConsumeItemUseForProfile(resolvedActionProfile.profile) : undefined;
    if (!isOffhand && item && selectedItemUse.limited && consumeUsesDecision !== false) {
      try {
        const res = await consumeItemUse(item, 1);
        if (res.ok) {
          ui.notifications.info(`🎯 Uso gastado: ${item.name} (${res.remaining}/${res.max})`);
          _refreshUsesUi(form, item, res);
        } else {
          ui.notifications.warn(`⚠️ No se pudo gastar uso de ${item.name}.`);
        }
      } catch (err) {
        console.warn('[ol-attack] Error consumiendo uso del item seleccionado', item?.name, err);
      }
    }

    for (const fc of pendingFeatureConsumes) {
      if (fc.kind === "wails") continue;
      try {
        const res = await consumeItemUse(fc.item, 1);
        if (res.ok) {
          ui.notifications.info(`🎯 Uso gastado: ${fc.item.name} (${res.remaining}/${res.max})`);
          _refreshUsesUi(form, fc.item, res);
          if (fc.autoUncheck) {
            form.find(`input[name="${fc.toggleName}"]`).prop("checked", false);
            this._saveFormToPrefs(form);
          }
        } else {
          ui.notifications.warn(`⚠️ No se pudo gastar uso de ${fc.item.name}.`);
        }
      } catch (err) {
        console.warn('[ol-attack] Error consumiendo uso de rasgo', fc?.item?.name, err);
      }
    }

    // Concentración (macro): si lanzas un hechizo de concentración desde aquí, marcamos el indicador.
    if (!isOffhand && item?.type === "spell" && isConcentrationSpell(item)) {
      await actor.setFlag(FLAG_SCOPE, FLAG_CONCENTRATION, { name: item.name, itemId: item.id, ts: Date.now() });
      try { this.render(false); } catch {}
    }

    // Wails from the Grave / Lamentos desde la tumba (segunda tarjeta + consumo de usos)
    if (!isOffhand && item && applyWails) {
      if (!applySneak) {
        ui.notifications.warn("👻 Lamentos desde la tumba requiere que también apliques Ataque Furtivo en este turno.");
      } else if (!features.wailsItemId) {
        ui.notifications.warn("👻 No encuentro el rasgo 'Lamentos desde la tumba' en la ficha para gestionar sus usos.");
      } else if (!features.wailsFormula || features.wailsFormula === "0") {
        ui.notifications.warn("👻 No se pudo calcular los dados de Lamentos (¿Ataque Furtivo = 0?).");
      } else {
        const wItem = actor.items.get(features.wailsItemId);
        const u = wItem ? getItemUses(wItem) : { max: 0, remaining: 0 };
        if (!wItem || u.max <= 0) {
          ui.notifications.warn("👻 El rasgo de Lamentos no tiene usos configurados en la ficha (system.uses).");
        } else if (u.remaining <= 0) {
          ui.notifications.warn(`👻 No te quedan usos de Lamentos (${u.remaining}/${u.max}).`);
        } else {
          // Elegir 2º objetivo (a 30ft del primero). Si ya hay 2 targets, usamos el segundo.
          const primary = originalTargets[0] || null;
          let secondary = originalTargets.length >= 2 ? originalTargets[1] : null;

          if (!secondary && primary && canvas?.tokens?.placeables?.length) {
            const inRange = canvas.tokens.placeables
              .filter((t) => t?.actor && t?.id !== primary.id)
              .filter((t) => {
                try {
                  const d = canvas.grid.measureDistance(primary.center, t.center);
                  return Number.isFinite(d) && d <= 30;
                } catch { return false; }
              });
            secondary = await _pickTokenFromList({
              title: "Lamentos desde la tumba — Segundo objetivo",
              subtitle: primary ? `Elige una criatura a 30 pies o menos de ${primary.name}.` : "Elige el segundo objetivo.",
              tokens: inRange
            });
          }

          if (!secondary) {
            ui.notifications.warn("👻 No se seleccionó un segundo objetivo para Lamentos.");
          } else {
            // Consumir uso
            const res = await consumeItemUse(wItem, 1);
            if (res.ok) {
              ui.notifications.info(`👻 Uso gastado: ${wItem.name} (${res.remaining}/${res.max})`);
              _refreshUsesUi(form, wItem, res);
              form.find('input[name="useWails"]').prop("checked", false);
              this._saveFormToPrefs(form);
            } else {
              ui.notifications.warn(`⚠️ No se pudo gastar uso de ${wItem.name} (restantes: ${u.remaining}/${u.max})`);
            }

            // Guardar y forzar target solo al secundario
            const prevTargets = Array.from(game.user?.targets ?? []);
            try {
              for (const t of prevTargets) t.setTarget(false, { user: game.user, releaseOthers: false });
              secondary.setTarget(true, { user: game.user, releaseOthers: true });
            } catch {}

            const wOpts = {
              ...opts,
              rollTitle: `👻 Lamentos — ${item.name}`,
              itemName: `👻 Lamentos — ${item.name}`,
              showDescription: false,
              showSaves: false,
              dmgMode: "manual",
              manualFormula: `${features.wailsFormula}`,
              manualType: "necrotic",
              // Debe seguir la norma homebrew (incluida Defensa CA-10 si procede)
              disableDefense: false,
              // Pero NO aplicamos bonos de daño del actor (estados) a este daño secundario por defecto
              disableActorDamageBonuses: true,
              // evita añadidos automáticos
              prof: false,
              temp: 0,
              ability: "none",
              applyRage: false,
              applyReckless: false,
              applyFrenzy: false,
              applySneak: false,
              applySavage: false,
              applyExtraDice: false
            };

            await runAction({ actor, token, item, opts: wOpts });

            // Restaurar targets
            try {
              for (const t of Array.from(game.user?.targets ?? [])) t.setTarget(false, { user: game.user, releaseOthers: false });
              for (const t of prevTargets) t.setTarget(true, { user: game.user, releaseOthers: false });
            } catch {}
          }
        }
      }
    }

    // mantener o cerrar
    this._persistWindowState();
    if (autoClose) this.close();
    else {
      // refrescar slots y preview (por si ha gastado slot/uses)
      this.render(true);
    }
    return result;
  }
}
// ============================================================
// Concentración (macro)
// Como esta macro no usa el flujo "Item.use()" del sistema, no se crean AEs de concentración automáticamente.
// Guardamos un flag con el nombre del hechizo/rasgo en concentración y lo mostramos como indicador.
// ============================================================

function isConcentrationSpell(item) {
  if (!item) return false;
  const props = gp(item, "system.properties") || gp(item, "system.spellProperties") || [];
  if (Array.isArray(props) && props.map(String).some(p => p.toLowerCase() === "concentration" || p.toLowerCase() === "concentración")) return true;
  const concDur = gp(item, "system.duration.concentration");
  if (concDur === true) return true;
  const durLabel = String(gp(item, "system.duration.units") || "").toLowerCase();
  if (durLabel.includes("concentration") || durLabel.includes("concentr")) return true;
  // fallback: leer labels/description
  const desc = String(gp(item, "system.description.value") || "").toLowerCase();
  if (desc.includes("concentration") || desc.includes("concentración")) return true;
  return false;
}

async function getConcentrationInfo(actor) {
  // 1) Si existe efecto de concentración (de sistema o módulos), intentamos sacar el nombre.
  try {
    const effects = Array.from(actor?.effects ?? []);
    const eff = effects.find(e => {
      const nm = String(e.name || "").toLowerCase();
      const statuses = Array.from(e.statuses ?? []).map(String);
      return statuses.some(s => String(s).toLowerCase().includes("concentr")) || nm.includes("concentrating") || nm.includes("concentration") || nm.includes("concentración");
    });
    if (eff) {
      let name = "";
      const nm = String(eff.name || "");
      const m = nm.match(/:\s*(.+)$/);
      if (m) name = m[1].trim();
      if (!name && eff.origin) {
        try {
          const doc = await fromUuid(eff.origin);
          name = doc?.name || "";
        } catch {}
      }
      if (!name) name = nm;
      return { active: true, name };
    }
  } catch {}

  // 2) Flag propio de OL Attack
  try {
    const f = await actor.getFlag(FLAG_SCOPE, FLAG_CONCENTRATION);
    if (f && f.name) return { active: true, name: String(f.name) };
  } catch {}
  return { active: false, name: "" };
}

