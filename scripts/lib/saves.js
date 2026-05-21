import { gp, safeNum, escapeHtml, makeStableKey, translateAbility } from "./utils.js";
import { getActivities } from "./actor.js";
import { getActorAbilityMod, getActorProfValue, getActorSpellDc } from "../shared/system-data.js";

async function resolveDCValue(dc, actor) {
  if (dc == null) return { dcVal: null, dcText: "Auto" };
  if (typeof dc === "number" && Number.isFinite(dc)) return { dcVal: dc, dcText: String(dc) };
  const s = String(dc).trim();
  const n = Number(s);
  if (Number.isFinite(n)) return { dcVal: n, dcText: String(n) };

  try {
    const rd = typeof actor?.getRollData === "function" ? actor.getRollData() : {};
    const r = new Roll(s, rd);
    await r.evaluate();
    if (Number.isFinite(r.total)) return { dcVal: r.total, dcText: String(r.total) };
  } catch {}
  return { dcVal: null, dcText: s || "Auto" };
}

export async function getSavesFromItem(item, actor, { isHomebrew = false } = {}) {
  const saves = [];
  const actArray = getActivities(item);
  const effectNames = item.effects ? Array.from(item.effects).map((e) => e.name) : [];
  const effectString = effectNames.length > 0 ? effectNames.join(" / ") : null;
  const isSpell = item?.type === "spell";

  for (let a of actArray) {
    if (!a) continue;
    if (a.type === "save" || a.save) {
      const rawAbility = gp(a, "save.ability");
      let ability = null;
      if (rawAbility instanceof Set) ability = Array.from(rawAbility)[0] || null;
      else if (Array.isArray(rawAbility)) ability = rawAbility[0] || null;
      else if (typeof rawAbility === "string" && rawAbility.trim()) ability = rawAbility.trim();

      let dc = gp(a, "save.dc.value");
      if (!Number(dc)) {
        const calculation = gp(a, "save.dc.calculation");
        if (calculation === "spellcasting") dc = getActorSpellDc(actor);
        else if (calculation && CONFIG.DND5E?.abilities?.[calculation]) {
          const prof = getActorProfValue(actor) || 0;
          const mod = getActorAbilityMod(actor, calculation) || 0;
          dc = 8 + prof + mod;
        }
      }
      if (!dc) {
        const form = gp(a, "save.dc.formula");
        if (form) dc = form;
        else dc = "Auto";
      }

      const hasDamage = Array.isArray(gp(a, "damage.parts")) && gp(a, "damage.parts").length > 0;
      let hasHealing = false;
      if (a.type === "heal") hasHealing = true;
      const healParts = gp(a, "healing.parts") ?? gp(a, "heal.parts");
      if (Array.isArray(healParts) && healParts.length > 0) hasHealing = true;
      const hpObj = gp(a, "healing") ?? gp(a, "heal");
      if (hpObj && !Array.isArray(hpObj) && (hpObj.number || hpObj.formula || hpObj.custom?.formula || hpObj.denomination)) hasHealing = true;

      let timing = isHomebrew ? "post" : (isSpell || hasDamage || hasHealing) ? "pre" : "post";

      const { dcVal, dcText } = await resolveDCValue(dc, actor);
      const justification = effectString || (a.name && a.name !== item.name ? a.name : null);
      if (ability) saves.push({ ability, dcVal, dcText, reason: justification, timing });
    }
  }

  // Fallback: muchos ítems (sobre todo conjuros de compendio) aún declaran TS en system.save
  try {
    const sysSave = gp(item, "system.save") || {};
    const rawAbility = gp(sysSave, "ability") ?? gp(item, "system.save.ability");
    let ability = null;
    if (rawAbility instanceof Set) ability = Array.from(rawAbility)[0] || null;
    else if (Array.isArray(rawAbility)) ability = rawAbility[0] || null;
    else if (typeof rawAbility === "string" && rawAbility.trim()) ability = rawAbility.trim();

    if (ability && !saves.some((s) => s.ability === ability)) {
      let dc = gp(sysSave, "dc.value") ?? gp(sysSave, "dc") ?? gp(item, "system.save.dc.value") ?? gp(item, "system.save.dc");
      if (!Number(dc)) {
        const calculation = gp(sysSave, "dc.calculation") ?? gp(item, "system.save.dc.calculation");
        if (calculation === "spellcasting") dc = getActorSpellDc(actor);
        else if (calculation && CONFIG.DND5E?.abilities?.[calculation]) {
          const prof = getActorProfValue(actor) || 0;
          const mod = getActorAbilityMod(actor, calculation) || 0;
          dc = 8 + prof + mod;
        }
      }
      if (!dc) dc = gp(sysSave, "dc.formula") ?? gp(item, "system.save.dc.formula") ?? "Auto";

      // Timing: por defecto PRE si es conjuro o si hay daño/curación en activities
      let timing = isHomebrew ? "post" : isSpell ? "pre" : "post";
      const { dcVal, dcText } = await resolveDCValue(dc, actor);
      const justification = effectString || null;
      saves.push({ ability, dcVal, dcText, reason: justification, timing });
    }
  } catch {}

  return saves;
}

export function renderSaveProgress({ saveKey, targetsMeta = [], saveTrack = {} }) {
  const done = saveTrack?.[saveKey] || {};
  const rows = targetsMeta.map((t) => {
    const aUuid = t.actorUuid;
    const ok = !!(aUuid && done[aUuid]);
    const cls = ok ? "ol-save-progress-badge done" : "ol-save-progress-badge";
    const badge = ok ? "✅" : "⏳";
    return `<span class="${cls}">${badge} ${escapeHtml(t.name || "Objetivo")}</span>`;
  });
  const countDone = targetsMeta.filter((t) => !!(t.actorUuid && done[t.actorUuid])).length;
  const total = targetsMeta.length || 0;

  return `
    <div style="margin-top:6px; font-size:11px; color:#bbb;">
      <div style="margin-bottom:4px;"><b>Progreso TS:</b> ${countDone}/${total}</div>
      <div>${rows.join("") || `<span style="color:#888;">(Sin objetivos)</span>`}</div>
    </div>
  `;
}

export function renderSavesHtml({ saveDefs = [], targetsMeta = [], saveTrack = {} }) {
  if (!saveDefs.length) return "";
  return `
  <!--OL-SAVES-START-->
  <div class="ol-saves" style="margin-top:8px; padding-top:8px; border-top:1px dashed #666">
    ${saveDefs.map((s) => {
      const dcLabel = Number.isFinite(Number(s.dcVal)) ? String(s.dcVal) : escapeHtml(s.dcText || "Auto");
      const title = `${translateAbility(s.ability).toUpperCase()} CD ${dcLabel}`;
      return `
        <div style="margin-bottom:10px;">
          <div style="font-size:11px; font-weight:bold; color:#a00; font-style:italic; margin-bottom:2px;">
            ${s.reason ? `⚠️ Aplica: ${escapeHtml(s.reason)}` : "⚠️ Requiere Salvación"}
          </div>
          <button type="button" class="ol-roll-save" data-savekey="${escapeHtml(s.saveKey)}" data-ability="${escapeHtml(s.ability)}"
            data-dc="${Number.isFinite(Number(s.dcVal)) ? escapeHtml(String(s.dcVal)) : ""}"
            data-dctext="${escapeHtml(s.dcText || "")}"
            data-timing="${escapeHtml(s.timing || "pre")}"
            style="font-size:11px; width:100%;">
            ${escapeHtml(title)}
          </button>
          <button type="button" class="ol-roll-save-gm ol-gm-only"
            data-gmmode="all"
            data-savekey="${escapeHtml(s.saveKey)}" data-ability="${escapeHtml(s.ability)}"
            data-dc="${Number.isFinite(Number(s.dcVal)) ? escapeHtml(String(s.dcVal)) : ""}"
            data-dctext="${escapeHtml(s.dcText || "")}"
            data-timing="${escapeHtml(s.timing || "pre")}"
            style="font-size:11px; width:100%; margin-top:6px;">
            ${escapeHtml(game.i18n?.localize?.("OLATTACK.GMRollAll") || "GM: Tirar por todos")}
          </button>
          ${renderSaveProgress({ saveKey: s.saveKey, targetsMeta, saveTrack })}
        </div>
      `;
    }).join("")}
  </div>
  <!--OL-SAVES-END-->
  `;
}

export function buildSaveDefs({ rollTitle, saves }) {
  return saves.map((s) => {
    const dcKey = Number.isFinite(s.dcVal) ? String(s.dcVal) : (s.dcText || "Auto");
    const raw = `${rollTitle}|${s.ability}|${dcKey}|${s.timing || "pre"}|${s.reason || ""}`;
    return { ...s, saveKey: makeStableKey(raw) };
  });
}
