import { FLAG_VISIBLE, FLAG_OFFHAND_ENABLED, FLAG_OFFHAND_WEAPON, FLAG_AUTO_CLOSE } from "../shared/constants.js";
import { olDialog } from "./dialogs.js";
import { leerFlag, escribirFlag } from "../lib/flags.js";
import { escapeHtml } from "../lib/utils.js";
import { getAttackItems, getEquippedWeapons, getWeaponDamageType } from "../lib/actor.js";
import { getSpellLevel } from "../lib/spells.js";

const t = (key, data) => game.i18n.format(key, data ?? {});

/** Qué aparece en la lista de OL Attack de un personaje, cierre automático y mano débil. */
export async function openVisibilityConfig({ actor }) {
  if (!(actor.isOwner || game.user.isGM)) {
    ui.notifications.warn(t("OLATTACK.Config.NoPermission"));
    return false;
  }

  const allAttackItems = getAttackItems(actor);
  const equippedWeapons = getEquippedWeapons(actor);

  const current = foundry.utils.deepClone(leerFlag(actor, FLAG_VISIBLE) || {});
  const offhandEnabled = leerFlag(actor, FLAG_OFFHAND_ENABLED) || false;
  const offhandWeaponId = leerFlag(actor, FLAG_OFFHAND_WEAPON) || null;
  const autoClose = leerFlag(actor, FLAG_AUTO_CLOSE) !== false;

  const mkGroup = (arr, title, icon) => {
    if (!arr.length) return "";
    return `
      <div class="ol-vis-group">
        <div class="ol-vis-title"><i class="${icon}"></i> ${title}</div>
        ${arr.map((it) => `
          <label class="ol-vis-row" data-name="${escapeHtml(String(it.name).toLowerCase())}">
            <input type="checkbox" class="ol-vis-check" data-id="${it.id}" ${current?.[it.id] !== false ? "checked" : ""}>
            <img src="${escapeHtml(it.img || "icons/svg/mystery-man.svg")}" alt="">
            <span class="ol-vis-name">${escapeHtml(it.name)}</span>
            <span class="ol-vis-type">${escapeHtml(it.type)}</span>
          </label>`).join("")}
      </div>`;
  };

  const spells = allAttackItems.filter((i) => i.type === "spell");
  const porNivel = new Map();
  for (const sp of spells) {
    const lvl = Math.max(0, Math.min(9, Number(getSpellLevel(sp) || 0)));
    if (!porNivel.has(lvl)) porNivel.set(lvl, []);
    porNivel.get(lvl).push(sp);
  }
  const spellsHtml = [...porNivel.entries()].sort((a, b) => a[0] - b[0]).map(([lvl, arr]) => {
    arr.sort((a, b) => a.name.localeCompare(b.name));
    return mkGroup(arr, lvl === 0 ? t("OLATTACK.Spell.Cantrips") : t("OLATTACK.Spell.Level", { n: lvl }), "fa-solid fa-wand-sparkles");
  }).join("");

  const content = `
    <div class="ol-vis-root">
      <section class="ol-vis-section">
        <label class="ol-toggle ol-toggle-wide"><input type="checkbox" id="ol-auto-close" ${autoClose ? "checked" : ""}><span>${t("OLATTACK.Config.AutoClose")}</span></label>
        <label class="ol-toggle ol-toggle-wide"><input type="checkbox" id="ol-offhand-enable" ${offhandEnabled ? "checked" : ""}><span>${t("OLATTACK.Config.Offhand")}</span></label>
        <div id="ol-offhand-weapon-select" class="ol-vis-offhand" ${offhandEnabled ? "" : "hidden"}>
          <label class="ol-field"><span>${t("OLATTACK.Config.OffhandWeapon")}</span>
            <select class="ol-input" id="ol-offhand-weapon">
              <option value="">${t("OLATTACK.Config.NoWeapon")}</option>
              ${equippedWeapons.map((w) => `<option value="${w.id}" ${w.id === offhandWeaponId ? "selected" : ""}>${escapeHtml(w.name)} (${escapeHtml(getWeaponDamageType(w))})</option>`).join("")}
            </select>
          </label>
        </div>
      </section>

      <input class="ol-input ol-vis-search" type="search" placeholder="${t("OLATTACK.Main.Search")}" aria-label="${t("OLATTACK.Main.Search")}">
      <div class="ol-vis-lists">
        ${mkGroup(allAttackItems.filter((i) => i.type === "weapon"), t("OLATTACK.Main.Weapons"), "fa-solid fa-sword")}
        ${spellsHtml}
        ${mkGroup(allAttackItems.filter((i) => i.type !== "weapon" && i.type !== "spell"), t("OLATTACK.Main.OtherFeatures"), "fa-solid fa-star")}
      </div>
      <p class="ol-nota">${t("OLATTACK.Config.Hint")}</p>
    </div>`;

  const guardado = await olDialog({
    title: "OLATTACK.ConfigTitle", icon: "fa-solid fa-gear", width: 520, content, memoria: "visibility-config",
    buttons: [
      {
        action: "save", label: t("OLATTACK.Save"), icon: "fa-solid fa-check", default: true,
        callback: async (_ev, button) => {
          const f = button.form;
          const newMap = {};
          f.querySelectorAll("input.ol-vis-check").forEach((el) => {
            if (!el.checked) newMap[el.dataset.id] = false;
            else newMap[`-=${el.dataset.id}`] = null; // quita el marcador de oculto
          });
          await escribirFlag(actor, FLAG_VISIBLE, newMap);
          await escribirFlag(actor, FLAG_AUTO_CLOSE, f.querySelector("#ol-auto-close").checked);
          await escribirFlag(actor, FLAG_OFFHAND_ENABLED, f.querySelector("#ol-offhand-enable").checked);
          await escribirFlag(actor, FLAG_OFFHAND_WEAPON, f.querySelector("#ol-offhand-weapon").value || null);
          return true;
        }
      },
      { action: "cancel", label: t("OLATTACK.Cancel"), icon: "fa-solid fa-xmark", callback: () => false }
    ],
    render: (_ev, dialog) => {
      const root = dialog.element;
      const toggle = root.querySelector("#ol-offhand-enable");
      const weapon = root.querySelector("#ol-offhand-weapon-select");
      toggle.addEventListener("change", () => { weapon.hidden = !toggle.checked; });
      root.querySelector(".ol-vis-search").addEventListener("input", (ev) => {
        const q = String(ev.target.value || "").toLowerCase().trim();
        root.querySelectorAll(".ol-vis-row").forEach((row) => { row.hidden = !!q && !(row.dataset.name || "").includes(q); });
      });
    }
  });
  return guardado === true;
}
