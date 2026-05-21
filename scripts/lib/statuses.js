import { LegacyDialog } from "../shared/compat.js";
import { escapeHtml, gp } from "./utils.js";

function _norm(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function _getRawStatusEffects() {
  const src = globalThis.CONFIG?.statusEffects;
  if (!src) return [];
  if (Array.isArray(src)) return src;
  if (src instanceof Set) return Array.from(src.values());
  if (typeof src?.values === "function") return Array.from(src.values());
  if (typeof src === "object") return Object.values(src);
  return [];
}

function _localizeMaybe(label) {
  const raw = String(label || "").trim();
  if (!raw) return "";
  try {
    if (game.i18n?.has?.(raw)) return game.i18n.localize(raw);
  } catch (_) {}
  return raw;
}

export function getAvailableStatuses() {
  const seen = new Set();
  const out = [];
  for (const raw of _getRawStatusEffects()) {
    const statuses = (() => {
      const r = raw?.statuses;
      if (!r) return [];
      if (Array.isArray(r)) return r.map((v) => String(v || "").trim()).filter(Boolean);
      if (r instanceof Set) return Array.from(r.values()).map((v) => String(v || "").trim()).filter(Boolean);
      if (typeof r?.values === "function") return Array.from(r.values()).map((v) => String(v || "").trim()).filter(Boolean);
      return [];
    })();
    const id = String(raw?.id || raw?.statusId || statuses[0] || raw?.name || raw?.label || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = _localizeMaybe(raw?.name || raw?.label || raw?.title || id) || id;
    const icon = String(raw?.img || raw?.icon || "icons/svg/aura.svg").trim() || "icons/svg/aura.svg";
    out.push({ id, label, icon, statuses, raw });
  }
  out.sort((a, b) => a.label.localeCompare(b.label, "es", { sensitivity: "base" }));
  return out;
}

export function getStatusEntry(statusId) {
  const id = String(statusId || "").trim();
  if (!id) return null;
  const direct = getAvailableStatuses().find((s) => s.id === id || s.statuses.includes(id));
  if (direct) return direct;
  return { id, label: _localizeMaybe(id) || id, icon: "icons/svg/aura.svg", statuses: [id], raw: { id, label: id } };
}

function _matchEffectByStatus(effect, statusId, entry = null) {
  if (!effect || effect.disabled) return false;
  const statuses = (() => {
    const raw = effect.statuses;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map((v) => String(v || ""));
    if (raw instanceof Set) return Array.from(raw.values()).map((v) => String(v || ""));
    if (typeof raw?.values === "function") return Array.from(raw.values()).map((v) => String(v || ""));
    return [];
  })();
  if (statuses.includes(statusId)) return true;
  if (entry?.statuses?.some((s) => statuses.includes(String(s)))) return true;
  const coreId = String(gp(effect, "flags.core.statusId") || "").trim();
  if (coreId && (coreId === statusId || entry?.statuses?.includes(coreId))) return true;
  const label = _norm(effect.name || effect.label || "");
  if (entry && label && label === _norm(entry.label)) return true;
  return false;
}

export function isStatusActiveOnActor(actor, statusId) {
  const entry = getStatusEntry(statusId);
  if (!actor || !entry) return false;
  try {
    if (actor.statuses?.has?.(entry.id)) return true;
    for (const s of Array.from(actor.statuses || [])) {
      const raw = String(s || "");
      if (raw === entry.id || entry.statuses.includes(raw)) return true;
    }
  } catch (_) {}
  for (const effect of Array.from(actor.effects || [])) {
    if (_matchEffectByStatus(effect, entry.id, entry)) return true;
  }
  return false;
}

function _resolveTokenDocument(actor, token = null) {
  if (token?.document) return token.document;
  if (token?.documentName === "Token") return token;
  if (token?.object?.document) return token.object.document;
  try {
    const actives = actor?.getActiveTokens?.(true, true) || actor?.getActiveTokens?.() || [];
    const first = Array.from(actives || [])[0];
    return first?.document || first || null;
  } catch (_) {}
  return null;
}

function _buildManualEffectData(actor, entry) {
  return {
    name: entry.label,
    label: entry.label,
    img: entry.icon,
    icon: entry.icon,
    origin: actor?.uuid || null,
    disabled: false,
    statuses: [entry.id],
    flags: {
      core: {
        statusId: entry.id
      }
    }
  };
}

export async function setStatusOnSubject({ actor, token = null, statusId, active = true } = {}) {
  const entry = getStatusEntry(statusId);
  if (!actor || !entry) return { ok: false, label: entry?.label || statusId, reason: "missing-actor-or-status" };
  const tokenDoc = _resolveTokenDocument(actor, token);

  try {
    if (tokenDoc?.toggleActiveEffect) {
      await tokenDoc.toggleActiveEffect(entry.raw || entry.id, { active: !!active });
      return { ok: true, label: entry.label, via: "tokenDoc" };
    }
  } catch (err) {
    console.warn("[ol-attack] No se pudo aplicar estado vía tokenDoc.toggleActiveEffect", err);
  }

  try {
    if (actor?.toggleStatusEffect) {
      await actor.toggleStatusEffect(entry.raw || entry.id, { active: !!active });
      return { ok: true, label: entry.label, via: "actor.toggleStatusEffect" };
    }
  } catch (err) {
    console.warn("[ol-attack] No se pudo aplicar estado vía actor.toggleStatusEffect", err);
  }

  try {
    const existing = Array.from(actor.effects || []).filter((effect) => _matchEffectByStatus(effect, entry.id, entry));
    if (active) {
      if (existing.length) return { ok: true, label: entry.label, via: "manual-existing" };
      await actor.createEmbeddedDocuments("ActiveEffect", [_buildManualEffectData(actor, entry)]);
      return { ok: true, label: entry.label, via: "manual-create" };
    }
    if (existing.length) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map((e) => e.id).filter(Boolean));
      return { ok: true, label: entry.label, via: "manual-delete" };
    }
    return { ok: true, label: entry.label, via: "manual-none" };
  } catch (err) {
    console.warn("[ol-attack] No se pudo aplicar/quitar estado manualmente", err);
    return { ok: false, label: entry.label, reason: err?.message || String(err) };
  }
}

function _buildStatusPickerContent({ actor, mode = "apply" } = {}) {
  const allStatuses = getAvailableStatuses();
  const activeStatuses = allStatuses.filter((s) => isStatusActiveOnActor(actor, s.id));
  const statuses = mode === "remove" ? activeStatuses : allStatuses;
  const activeSet = new Set(activeStatuses.map((s) => s.id));
  const emptyText = mode === "remove"
    ? "Este personaje no tiene estados activos que OL Attack pueda quitar ahora mismo."
    : "No se han encontrado estados disponibles en la configuración del sistema.";

  return `
    <div class="ol-status-picker ol-theme-panel" data-mode="${escapeHtml(mode)}">
      <div class="ol-status-intro">${mode === "remove" ? "Quita uno de los estados activos del personaje. Solo se muestran los estados que están aplicados ahora mismo." : "Aplica un estado al personaje. Si ya está activo, el botón aparece desactivado para evitar duplicados."}</div>
      <input type="text" class="ol-status-search" placeholder="Buscar estado...">
      <div class="ol-status-list">
        ${statuses.length ? statuses.map((status) => {
          const isActive = activeSet.has(status.id);
          const actionDisabled = mode === "remove" ? !isActive : isActive;
          const actionLabel = mode === "remove" ? "Quitar" : "Aplicar";
          const stateLabel = isActive ? "Activo" : "No activo";
          return `
            <div class="ol-status-row ol-theme-card" data-search="${escapeHtml(`${status.label} ${status.id}`.toLowerCase())}" data-active="${isActive ? "true" : "false"}">
              <div class="ol-status-icon-wrap">
                <img class="ol-status-icon" src="${escapeHtml(status.icon)}" alt="${escapeHtml(status.label)}">
              </div>
              <div class="ol-status-meta">
                <div class="ol-status-label" title="${escapeHtml(status.label)}">${escapeHtml(status.label)}</div>
                <div class="ol-status-subline ${isActive ? "is-active" : "is-inactive"}">${escapeHtml(stateLabel)} · <code>${escapeHtml(status.id)}</code></div>
              </div>
              <button type="button" class="ol-status-action ${mode === "remove" ? "remove" : "apply"}" data-status-id="${escapeHtml(status.id)}" ${actionDisabled ? "disabled" : ""}>
                ${actionLabel}
              </button>
            </div>`;
        }).join("") : `<div class="ol-status-empty ol-theme-card">${escapeHtml(emptyText)}</div>`}
      </div>
    </div>`;
}

export async function openStatusPicker({ actor, token = null, mode = "apply", title = null } = {}) {
  if (!actor) return null;
  const dialog = new LegacyDialog({
    title: title || `${mode === "remove" ? "Quitar" : "Aplicar"} estado · ${actor.name}`,
    content: _buildStatusPickerContent({ actor, mode }),
    buttons: {
      close: { label: "Cerrar" }
    }
  }, { width: 700, height: 760 });
  dialog.render(true);
  setTimeout(() => {
    const html = dialog.element;
    if (!html?.length) return;
    html.addClass("ol-theme-dialog ol-status-dialog");
    html.find(".ol-status-search").trigger("focus");
    html.find(".ol-status-search").on("input", (ev) => {
      const q = _norm(ev.currentTarget.value || "");
      html.find(".ol-status-row").each((_, el) => {
        const hay = _norm(el.dataset.search || "");
        el.style.display = !q || hay.includes(q) ? "flex" : "none";
      });
    });
    html.find(".ol-status-action").on("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const btn = ev.currentTarget;
      const statusId = String(btn.dataset.statusId || "").trim();
      if (!statusId) return;
      btn.disabled = true;
      const result = await setStatusOnSubject({ actor, token, statusId, active: mode !== "remove" });
      if (result?.ok) {
        ui.notifications.info(`${mode === "remove" ? "Estado quitado" : "Estado aplicado"}: ${result.label}`);
        try {
          for (const app of Object.values(ui.windows || {})) {
            const name = app?.constructor?.name || "";
            if (name === "OLAttackApp" || name === "OLSceneTrackerApp") app.render(false);
          }
        } catch (_) {}
        dialog.close();
      } else {
        btn.disabled = false;
        ui.notifications.warn(`No se pudo ${mode === "remove" ? "quitar" : "aplicar"} el estado.`);
      }
    });
  }, 0);
  return dialog;
}

export async function openActorStatusQuickMenu({ actor, token = null, title = null } = {}) {
  if (!actor) return null;
  return await new Promise((resolve) => {
    const dialog = new LegacyDialog({
      title: title || actor.name,
      content: `
        <div class="ol-quickmenu-panel ol-theme-panel">
          <div class="ol-quickmenu-title">Opciones rápidas</div>
          <div class="ol-quickmenu-help">Desde aquí puedes marcar el token como objetivo, indicar que el GM lo está manejando o abrir el gestor rápido de estados.</div>
        </div>`,
      buttons: {
        applyState: {
          label: "Aplicar estado",
          callback: async () => {
            await openStatusPicker({ actor, token, mode: "apply", title: `Aplicar estado · ${actor.name}` });
            resolve("applyState");
          }
        },
        removeState: {
          label: "Quitar estado",
          callback: async () => {
            await openStatusPicker({ actor, token, mode: "remove", title: `Quitar estado · ${actor.name}` });
            resolve("removeState");
          }
        },
        cancel: {
          label: game.i18n?.localize?.("Cancel") || "Cancelar",
          callback: () => resolve(null)
        }
      },
      default: "applyState"
    }, { width: 480 });
    dialog.render(true);
    setTimeout(() => {
      const html = dialog.element;
      if (!html?.length) return;
      html.addClass("ol-theme-dialog ol-quickmenu-dialog");
    }, 0);
  });
}
