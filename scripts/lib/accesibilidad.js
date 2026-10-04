/**
 * Accesibilidad. Ajustes de cliente (cada persona los suyos, en su navegador) y un panel con un
 * icono en la cabecera de todas las ventanas del módulo, junto al de cerrar:
 * tamaño del texto, alto contraste, fuente de alta legibilidad, reducir movimiento y ayuda inmediata.
 * Solo cambian variables y clases del <body>; los componentes no tienen casos especiales.
 */
import { MODULE_ID } from "../shared/constants.js";
import { ApplicationV2 } from "../shared/compat.js";

const CLAVES = ["a11yEscala", "a11yContraste", "a11yLegible", "a11yMovimiento", "a11yAyuda"];
const CAJAS = [
  ["a11yContraste", "OLATTACK.A11y.Contrast", "OLATTACK.A11y.ContrastHint"],
  ["a11yLegible", "OLATTACK.A11y.Legible", "OLATTACK.A11y.LegibleHint"],
  ["a11yMovimiento", "OLATTACK.A11y.Motion", "OLATTACK.A11y.MotionHint"],
  ["a11yAyuda", "OLATTACK.A11y.Help", "OLATTACK.A11y.HelpHint"]
];
const t = (k, d) => game.i18n.format(k, d ?? {});

export function aplicarAccesibilidad() {
  const g = (k) => game.settings.get(MODULE_ID, k);
  document.documentElement.style.setProperty("--ol-escala", String(g("a11yEscala") / 100));
  document.body.classList.toggle("ol-contraste", g("a11yContraste"));
  document.body.classList.toggle("ol-legible", g("a11yLegible"));
  document.body.classList.toggle("ol-sin-movimiento", g("a11yMovimiento"));
  const tip = game.tooltip?.constructor;
  if (tip) tip.TOOLTIP_ACTIVATION_MS = g("a11yAyuda") ? 60 : 500;
}

/** Registrar en `init`. */
export function registrarAccesibilidad() {
  const reg = (clave, datos) => game.settings.register(MODULE_ID, clave, {
    scope: "client", config: true, onChange: () => { aplicarAccesibilidad(); repintar(); }, ...datos
  });
  reg("a11yEscala", { name: "OLATTACK.A11y.ScaleName", hint: "OLATTACK.A11y.ScaleHint", type: Number, default: 100, range: { min: 85, max: 160, step: 5 } });
  reg("a11yContraste", { name: "OLATTACK.A11y.Contrast", hint: "OLATTACK.A11y.ContrastHint", type: Boolean, default: false });
  reg("a11yLegible", { name: "OLATTACK.A11y.Legible", hint: "OLATTACK.A11y.LegibleHint", type: Boolean, default: false });
  reg("a11yMovimiento", { name: "OLATTACK.A11y.Motion", hint: "OLATTACK.A11y.MotionHint", type: Boolean, default: false });
  reg("a11yAyuda", { name: "OLATTACK.A11y.Help", hint: "OLATTACK.A11y.HelpHint", type: Boolean, default: true });
  Hooks.once("ready", aplicarAccesibilidad);
}

function repintar() {
  for (const app of foundry.applications.instances.values()) if (app instanceof PanelAccesibilidad) app.render();
}

export class PanelAccesibilidad extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "ol-attack-a11y", classes: ["ol-attack", "ol-window", "ol-dialog", "ol-a11y"], position: { width: 380, height: "auto" },
    window: { title: "OLATTACK.A11y.Title", icon: "fa-solid fa-universal-access" }
  };

  static abrir() { return new PanelAccesibilidad().render({ force: true }); }

  async _renderHTML() {
    const g = (k) => game.settings.get(MODULE_ID, k);
    const filas = CAJAS.map(([k, nombre, ayuda]) => `<label class="ol-a11y-fila"><input type="checkbox" name="${k}" ${g(k) ? "checked" : ""}><span>${t(nombre)}<small>${t(ayuda)}</small></span></label>`).join("");
    return `<div class="ol-a11y-panel">
      <label class="ol-a11y-fila ol-a11y-escala"><span>${t("OLATTACK.A11y.ScaleLabel")} <b>${g("a11yEscala")}%</b></span>
        <input type="range" name="a11yEscala" min="85" max="160" step="5" value="${g("a11yEscala")}" aria-label="${t("OLATTACK.A11y.ScaleLabel")}"></label>
      ${filas}
      <p class="ol-nota">${t("OLATTACK.A11y.Note")}</p>
      <div class="ol-acciones"><button type="button" data-restablecer><i class="fa-solid fa-rotate-left"></i> ${t("OLATTACK.A11y.Reset")}</button></div>
    </div>`;
  }

  _replaceHTML(html, contenido) {
    contenido.innerHTML = html;
    contenido.querySelectorAll("input").forEach((el) => el.addEventListener("change", () => {
      game.settings.set(MODULE_ID, el.name, el.type === "checkbox" ? el.checked : Number(el.value));
    }));
    contenido.querySelector("input[type=range]")?.addEventListener("input", (ev) => {
      ev.target.closest("label").querySelector("b").textContent = `${ev.target.value}%`;
    });
    contenido.querySelector("[data-restablecer]")?.addEventListener("click", async () => {
      for (const k of CLAVES) await game.settings.set(MODULE_ID, k, game.settings.settings.get(`${MODULE_ID}.${k}`).default);
    });
  }
}

/** El icono va en la cabecera, justo antes del de cerrar. */
export function anadirBotonAccesibilidad(app) {
  const cab = app.element?.querySelector(".window-header");
  if (!cab || cab.querySelector(".ol-a11y-boton")) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "header-control icon fa-solid fa-universal-access ol-a11y-boton";
  b.dataset.tooltip = t("OLATTACK.A11y.Title");
  b.setAttribute("aria-label", t("OLATTACK.A11y.Title"));
  b.addEventListener("click", (ev) => { ev.stopPropagation(); PanelAccesibilidad.abrir(); });
  const cerrar = cab.querySelector('[data-action="close"]');
  if (cerrar) cerrar.before(b); else cab.append(b);
}
