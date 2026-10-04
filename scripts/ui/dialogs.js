/**
 * Diálogos del módulo sobre DialogV2 (sustituyen a los Dialog V1, retirados en Foundry 16).
 * Todos llevan el tema del módulo, el icono de accesibilidad y recuerdan su posición.
 */
import { DialogV2 } from "../shared/compat.js";
import { ConMemoria } from "../lib/memoria.js";
import { anadirBotonAccesibilidad } from "../lib/accesibilidad.js";

const t = (k, d) => game.i18n.format(k, d ?? {});

class OLDialog extends ConMemoria(DialogV2) {
  // Los diálogos tienen alto automático: solo se recuerdan posición y anchura.
  static CAMPOS_MEMORIA = ["left", "top", "width"];
}

/**
 * @param {object} cfg
 * @param {string} cfg.title        Título (texto o clave de idioma).
 * @param {string} [cfg.icon]       Clases Font Awesome del icono de la cabecera.
 * @param {string} cfg.content      HTML del cuerpo.
 * @param {object[]} [cfg.buttons]  [{action, label, icon, default, callback(event, button, dialog)}]
 * @param {number} [cfg.width]
 * @param {string} [cfg.memoria]    Identificador para recordar posición cuando varios diálogos comparten clase.
 * @param {Function} [cfg.render]   (event, dialog) tras pintar; recibe el elemento en dialog.element.
 * @returns {Promise<any>}          Lo que devuelva el callback del botón, o null si se cierra.
 */
export function olDialog({ title, icon = "fa-solid fa-burst", content, buttons, width = 480, classes = [], memoria, render, ...resto } = {}) {
  return OLDialog.wait({
    window: { title: game.i18n.localize(title), icon },
    classes: ["ol-attack", "ol-window", "ol-dialog", ...classes],
    position: { width },
    content,
    memoria: memoria ?? String(title),
    buttons: buttons ?? [{ action: "ok", label: t("OLATTACK.Close"), icon: "fa-solid fa-check", default: true }],
    rejectClose: false,
    render: (event, dialog) => {
      anadirBotonAccesibilidad(dialog);
      render?.(event, dialog);
    },
    ...resto
  });
}

/** Sí/No. Devuelve true solo si se pulsa «Sí». */
export async function olConfirm({ title, content, yes = "OLATTACK.Yes", no = "OLATTACK.Cancel", danger = false, width = 420 } = {}) {
  const r = await olDialog({
    title, width, content: `<p>${content}</p>`,
    buttons: [
      { action: "yes", label: t(yes), icon: danger ? "fa-solid fa-trash" : "fa-solid fa-check", default: !danger, callback: () => true },
      { action: "no", label: t(no), icon: "fa-solid fa-xmark", default: danger, callback: () => false }
    ]
  });
  return r === true;
}

/** Lista de opciones; devuelve la clave elegida o null. `options`: [{key, label, hint?, img?}] */
export function olChoose({ title, intro = "", options = [], width = 440 } = {}) {
  const esc = foundry.utils.escapeHTML;
  const rows = options.map((o, i) => `
    <button type="button" class="ol-choice" data-key="${esc(String(o.key ?? i))}">
      ${o.img ? `<img src="${esc(o.img)}" alt="">` : ""}
      <span class="ol-choice-text"><b>${esc(o.label ?? "")}</b>${o.hint ? `<small>${esc(o.hint)}</small>` : ""}</span>
    </button>`).join("");
  return olDialog({
    title, width,
    content: `${intro ? `<p class="ol-nota">${intro}</p>` : ""}<div class="ol-choice-list">${rows}</div>`,
    buttons: [{ action: "cancel", label: t("OLATTACK.Cancel"), icon: "fa-solid fa-xmark", default: true, callback: () => null }],
    render: (_ev, dialog) => {
      dialog.element.querySelectorAll(".ol-choice").forEach((b) => b.addEventListener("click", () => {
        dialog._olElegido = b.dataset.key;
        dialog.close();
      }));
    },
    close: (_ev, dialog) => dialog._olElegido ?? null
  });
}

/** Número entero acotado (p. ej. PG actuales). Devuelve el número o null. */
export function olNumber({ title, label, value = 0, min = 0, max = null, width = 360 } = {}) {
  return olDialog({
    title, width,
    content: `<label class="ol-campo"><span>${label}</span><input type="number" name="n" value="${Number(value) || 0}" min="${min}" ${max != null ? `max="${max}"` : ""} step="1" autofocus></label>`,
    buttons: [
      {
        action: "ok", label: t("OLATTACK.Save"), icon: "fa-solid fa-check", default: true,
        callback: (_ev, button) => {
          const n = Math.trunc(Number(button.form.elements.n.value));
          if (!Number.isFinite(n)) return null;
          return Math.max(min, max != null ? Math.min(max, n) : n);
        }
      },
      { action: "cancel", label: t("OLATTACK.Cancel"), icon: "fa-solid fa-xmark", callback: () => null }
    ]
  });
}
