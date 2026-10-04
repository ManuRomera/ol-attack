/**
 * Base común de las ventanas del módulo: ApplicationV2 + Handlebars + memoria de ventana,
 * icono de accesibilidad en la cabecera y encuadre de retratos.
 *
 * Las ventanas conservan sus métodos `getData()` y `activateListeners(html)` (con `html` como
 * jQuery de la parte pintada): así la lógica se migró sin reescribirla, y el DOM se renueva
 * entero en cada repintado, igual que antes.
 */
import { ApplicationV2, HandlebarsApplicationMixin, jq } from "../shared/compat.js";
import { ConMemoria } from "../lib/memoria.js";
import { anadirBotonAccesibilidad } from "../lib/accesibilidad.js";
import { pintarRetratos } from "../lib/retrato.js";

export class OLApp extends ConMemoria(HandlebarsApplicationMixin(ApplicationV2)) {
  static DEFAULT_OPTIONS = {
    classes: ["ol-attack", "ol-window"],
    window: { resizable: true, minimizable: true, icon: "fa-solid fa-burst" }
  };

  /** Contexto de plantilla: las subclases implementan getData() como en V1. */
  async _prepareContext(options) {
    return (await this.getData?.(options)) ?? {};
  }

  /** Parte principal pintada (jQuery). */
  get $main() {
    const el = this.element?.querySelector('[data-application-part="main"]');
    return el ? jq(el) : jq();
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender?.(context, options);
    if (this.constructor.DRAG_ANYWHERE) this._enableDragAnywhere();
  }

  /**
   * Ventanas de consulta rápida (monitores): se arrastran desde cualquier punto que no sea un
   * control, además de la cabecera. Un arrastre no dispara el clic que lo cierra.
   */
  _enableDragAnywhere() {
    const ignore = "button, input, select, textarea, a, label, summary, [data-action], .window-header, .window-resize-handle, .ol-context-menu, .ol-context-menu *";
    this.element.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || ev.target.closest(ignore)) return;
      const el = ev.target;
      // Agarrar una barra de desplazamiento no arrastra la ventana.
      if (el.scrollHeight > el.clientHeight && ev.offsetX > el.clientWidth) return;
      const startX = ev.clientX, startY = ev.clientY;
      const { left, top } = this.position;
      let moved = false;
      const move = (e) => {
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        moved = true;
        this.setPosition({ left: left + dx, top: top + dy });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        if (!moved) return;
        const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 80);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
    });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    anadirBotonAccesibilidad(this);
    pintarRetratos(this.element);
    const main = this.element.querySelector('[data-application-part="main"]');
    if (main) this.activateListeners?.(jq(main));
  }
}
