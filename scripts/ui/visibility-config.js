import { LegacyDialog } from "../shared/compat.js";
import { FLAG_SCOPE, FLAG_VISIBLE, FLAG_OFFHAND_ENABLED, FLAG_OFFHAND_WEAPON, FLAG_AUTO_CLOSE } from "../shared/constants.js";
import { escapeHtml } from "../lib/utils.js";
import { getAttackItems, getEquippedWeapons, getWeaponDamageType } from "../lib/actor.js";
import { getSpellLevel } from "../lib/spells.js";

export async function openVisibilityConfig({ actor }) {
  if (!(actor.isOwner || game.user.isGM)) {
    ui.notifications.warn("No tienes permiso para configurar esta lista.");
    return false;
  }

  const allAttackItems = getAttackItems(actor);
  const equippedWeapons = getEquippedWeapons(actor);

  let visibilityMap = (await actor.getFlag(FLAG_SCOPE, FLAG_VISIBLE)) || {};
  let offhandEnabled = (await actor.getFlag(FLAG_SCOPE, FLAG_OFFHAND_ENABLED)) || false;
  let offhandWeaponId = (await actor.getFlag(FLAG_SCOPE, FLAG_OFFHAND_WEAPON)) || null;
  let autoClose = (await actor.getFlag(FLAG_SCOPE, FLAG_AUTO_CLOSE)) !== false;

  const current = foundry.utils.deepClone(visibilityMap || {});

  const mkGroup = (arr, title) => {
    if (!arr.length) return "";
    return `
      <div class="ol-vis-group">
        <div class="ol-vis-title">${title}</div>
        ${arr.map((it) => `
          <label class="ol-vis-row" data-name="${escapeHtml(String(it.name).toLowerCase())}">
            <input type="checkbox" class="ol-vis-check" data-id="${it.id}" ${current?.[it.id] !== false ? "checked" : ""}>
            <img src="${it.img || "icons/svg/mystery-man.svg"}" onerror="this.src='icons/svg/sword.svg'">
            <span class="ol-vis-name">${escapeHtml(it.name)}</span>
            <span class="ol-vis-type">${escapeHtml(it.type)}</span>
          </label>`).join("")}
      </div>`;
  };

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
      out.push({ level: lvl, label: lvl === 0 ? "Trucos" : `Nivel ${lvl}`, items: arr });
    }
    return out;
  };

  const spells = allAttackItems.filter((i) => i.type === "spell");
  const spellGroups = groupSpellsByLevel(spells);
  const spellsHtml = spellGroups.map((g) => mkGroup(g.items, `✨ ${g.label}`)).join("");

  const content = `
    <div class="ol-vis-root">
      <div class="ol-config-section">
        <h4>🖥️ Comportamiento del Menú</h4>
        <p>Elige si el menú se cierra automáticamente tras cada tirada o se mantiene abierto.</p>
        <label class="ol-config-toggle"><input type="checkbox" id="ol-auto-close" ${autoClose ? "checked" : ""}><span>Cerrar menú automáticamente tras la tirada</span></label>
      </div>

      <div class="ol-config-section" style="border-color:#d29a38;">
        <h4>⚔️ Ataque con Dos Armas</h4>
        <p>Si habilitas esta opción, aparecerá un botón de mano débil en el menú principal.</p>
        <label class="ol-config-toggle"><input type="checkbox" id="ol-offhand-enable" ${offhandEnabled ? "checked" : ""}><span>Habilitar ataque con dos armas</span></label>
        <div id="ol-offhand-weapon-select" style="${offhandEnabled ? "" : "display:none;"} margin-top: 10px;">
          <p style="margin-bottom: 5px;">Selecciona el arma para mano débil (determina el tipo de daño):</p>
          <select class="ol-config-select" id="ol-offhand-weapon">
            <option value="">-- Sin arma (contundente) --</option>
            ${equippedWeapons.map((w) => `<option value="${w.id}" ${w.id === offhandWeaponId ? "selected" : ""}>${escapeHtml(w.name)} (${escapeHtml(getWeaponDamageType(w))})</option>`).join("")}
          </select>
        </div>
      </div>

      <div class="ol-vis-top"><input class="ol-vis-search" type="text" placeholder="Buscar..."></div>
      ${mkGroup(allAttackItems.filter((i) => i.type === "weapon"), "⚔️ Armas")}
      ${spellsHtml}
      ${mkGroup(allAttackItems.filter((i) => i.type !== "weapon" && i.type !== "spell"), "🎒 Otros / Rasgos")}
      <div class="ol-vis-hint">Desmarca lo que NO quieres que aparezca en el selector. Se guarda en el Actor.</div>
    </div>`;

  return await new Promise((res) => {
    new LegacyDialog({
      title: game.i18n.localize("OLATTACK.ConfigTitle"),
      content,
      buttons: {
        save: {
          label: game.i18n.localize("OLATTACK.Save"),
          callback: async (html) => {
            const newMap = {};
            html.find("input.ol-vis-check").each((_, el) => {
              if (!el.checked) newMap[el.dataset.id] = false;
              else newMap[`-=${el.dataset.id}`] = null; // keep parity with macro approach
            });

            autoClose = html.find("#ol-auto-close").is(":checked");
            offhandEnabled = html.find("#ol-offhand-enable").is(":checked");
            offhandWeaponId = html.find("#ol-offhand-weapon").val() || null;

            await actor.setFlag(FLAG_SCOPE, FLAG_VISIBLE, newMap);
            await actor.setFlag(FLAG_SCOPE, FLAG_AUTO_CLOSE, autoClose);
            await actor.setFlag(FLAG_SCOPE, FLAG_OFFHAND_ENABLED, offhandEnabled);
            await actor.setFlag(FLAG_SCOPE, FLAG_OFFHAND_WEAPON, offhandWeaponId);

            res(true);
          }
        },
        cancel: {
          label: game.i18n.localize("OLATTACK.Cancel"),
          callback: () => res(false)
        }
      },
      default: "save"
    }, { width: 520 }).render(true);

    Hooks.once("renderDialog", (app, html) => {
      const root = html;
      const search = root.find("input.ol-vis-search");
      const rows = () => root.find(".ol-vis-row");

      const offhandToggle = root.find("#ol-offhand-enable");
      const weaponSelectDiv = root.find("#ol-offhand-weapon-select");
      offhandToggle.on("change", () => weaponSelectDiv.toggle(offhandToggle.is(":checked")));

      search.on("input", () => {
        const q = String(search.val() || "").toLowerCase().trim();
        rows().each((_, el) => {
          const name = el.dataset.name || "";
          el.style.display = !q || name.includes(q) ? "" : "none";
        });
      });
    });
  });
}
