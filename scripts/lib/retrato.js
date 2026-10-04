/**
 * Encuadre del retrato. Cada personaje guarda qué zona de su imagen se ve y con cuánto zoom
 * (`flags.ol-attack.retrato = {x, y, z}`: centro del recorte como fracción 0-1 de la imagen y zoom 1-6).
 * El recorte es siempre cuadrado y se aplica con `object-view-box`, así que vale para cualquier
 * <img> sin envoltorios: las ventanas del módulo, el directorio de Actores y el combate.
 */
import { MODULE_ID } from "../shared/constants.js";
import { ApplicationV2, filePicker } from "../shared/compat.js";
import { ConMemoria } from "./memoria.js";

const acota = (v, min, max) => Math.min(max, Math.max(min, v));
const t = (k, d) => game.i18n.format(k, d ?? {});
export const ZOOM_MAX = 6;

export const retratoDe = (actor) => actor?.getFlag(MODULE_ID, "retrato") ?? null;

/** `inset()` en píxeles naturales del cuadrado que se ve. */
export function recorte({ x, y, z }, ancho, alto) {
  const lado = Math.min(ancho, alto) / Math.max(1, z);
  const izq = acota(x * ancho - lado / 2, 0, ancho - lado);
  const sup = acota(y * alto - lado / 2, 0, alto - lado);
  return `inset(${sup}px ${ancho - izq - lado}px ${alto - sup - lado}px ${izq}px)`;
}

/** Aplica (o quita, si no hay datos) el encuadre a una imagen. */
export function aplicar(img, datos) {
  if (!img) return;
  if (!datos) { img.style.objectViewBox = ""; return; }
  const poner = () => {
    if (!img.naturalWidth) return;
    img.style.objectFit = "cover";
    img.style.objectViewBox = recorte(datos, img.naturalWidth, img.naturalHeight);
  };
  if (img.complete && img.naturalWidth) poner(); else img.addEventListener("load", poner, { once: true });
}

const mismaImagen = (img, ruta) => {
  try { return decodeURIComponent(new URL(img.src, location.href).pathname).endsWith(`/${String(ruta).replace(/^\//, "")}`); }
  catch { return false; }
};

/** Aplica el encuadre en un fragmento de la interfaz: nuestras ventanas y las listas de Foundry. */
export function pintarRetratos(raiz = document) {
  const el = raiz instanceof HTMLElement ? raiz : raiz?.[0];
  if (!el) return;
  for (const img of el.querySelectorAll("img[data-retrato]")) aplicar(img, retratoDe(game.actors.get(img.dataset.retrato)));
  for (const li of el.querySelectorAll("li.directory-item[data-entry-id]")) {
    const a = game.actors.get(li.dataset.entryId);
    const img = li.querySelector("img.thumbnail");
    if (a && img && mismaImagen(img, a.img)) aplicar(img, retratoDe(a));
  }
  for (const li of el.querySelectorAll("li.combatant[data-combatant-id]")) {
    const c = ui.combat?.viewed?.combatants.get(li.dataset.combatantId);
    const img = li.querySelector("img.token-image");
    if (c?.actor && img && mismaImagen(img, c.actor.img)) aplicar(img, retratoDe(c.actor));
  }
}

/** Tras cambiar un encuadre se repinta lo que ya estaba en pantalla. */
export function repintarRetratos() {
  ui.actors?.render();
  ui.combat?.render();
  for (const app of foundry.applications.instances.values()) if (app.options?.classes?.includes("ol-window") && app.rendered) app.render();
  pintarRetratos(document.body);
}

/** Registrar en `ready`: pinta el encuadre en el directorio de Actores y en el combate. */
export function registrarRetratos() {
  Hooks.on("renderActorDirectory", (app, html) => pintarRetratos(html));
  Hooks.on("renderCombatTracker", (app, html) => pintarRetratos(html));
  Hooks.on("updateActor", (actor, cambios) => {
    if (foundry.utils.hasProperty(cambios, `flags.${MODULE_ID}.retrato`) || foundry.utils.hasProperty(cambios, `flags.${MODULE_ID}.-=retrato`)) repintarRetratos();
  });
}

export class EditorRetrato extends ConMemoria(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "ol-attack-retrato", classes: ["ol-attack", "ol-window", "ol-dialog", "ol-retrato-editor"], position: { width: 620, height: "auto" },
    window: { icon: "fa-solid fa-crop-simple", title: "OLATTACK.Portrait.Title" }
  };

  static MEMORIA = "retrato";
  static CAMPOS_MEMORIA = ["left", "top"];
  static abrir(actor) { return new EditorRetrato(actor).render({ force: true }); }

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.src = actor.img;
    this.r = { x: 0.5, y: 0.5, z: 1, ...(retratoDe(actor) ?? {}) };
  }

  get title() { return `${t("OLATTACK.Portrait.Title")} · ${this.actor.name}`; }

  async _renderHTML() {
    return `<div class="ol-ret">
      <div class="ol-ret-cuerpo">
        <div class="ol-ret-escenario" tabindex="0" role="application" aria-label="${t("OLATTACK.Portrait.Aria")}">
          <img class="base" src="${this.src}" alt="" draggable="false"><div class="marco"></div>
        </div>
        <div class="ol-ret-lado">
          <div class="vistas"><img class="v-grande" src="${this.src}" alt=""><img class="v-media" src="${this.src}" alt=""><img class="v-chica" src="${this.src}" alt=""></div>
          <label class="ol-campo"><span>Zoom <b class="zoom-valor"></b></span><input type="range" name="zoom" min="1" max="${ZOOM_MAX}" step="0.05" aria-label="Zoom"></label>
          <p class="ol-nota">${t("OLATTACK.Portrait.Note")}</p>
        </div>
      </div>
      <footer class="ol-ret-pie">
        <span class="ol-acciones"><button type="button" data-cambiar><i class="fa-solid fa-image"></i> ${t("OLATTACK.Portrait.Change")}</button><button type="button" data-restablecer><i class="fa-solid fa-rotate-left"></i> ${t("OLATTACK.A11y.Reset")}</button></span>
        <button type="button" class="principal" data-guardar><i class="fa-solid fa-check"></i> ${t("OLATTACK.Save")}</button>
      </footer>
    </div>`;
  }

  _replaceHTML(html, contenido) {
    contenido.innerHTML = html;
    this.el = contenido;
    this.escenario = contenido.querySelector(".ol-ret-escenario");
    this.base = contenido.querySelector("img.base");
    const arrancar = () => this.#dibujar();
    if (this.base.complete && this.base.naturalWidth) arrancar(); else this.base.addEventListener("load", arrancar, { once: true });
    this._observador?.disconnect();
    this._observador = new ResizeObserver(arrancar);
    this._observador.observe(this.escenario);

    const mover = (ev) => {
      const caja = this.base.getBoundingClientRect();
      this.r.x = acota((ev.clientX - caja.left) / caja.width, 0, 1);
      this.r.y = acota((ev.clientY - caja.top) / caja.height, 0, 1);
      this.#dibujar();
    };
    this.escenario.addEventListener("pointerdown", (ev) => {
      this.escenario.setPointerCapture(ev.pointerId);
      mover(ev);
      const seguir = (e) => mover(e);
      const soltar = () => { this.escenario.removeEventListener("pointermove", seguir); this.escenario.removeEventListener("pointerup", soltar); };
      this.escenario.addEventListener("pointermove", seguir);
      this.escenario.addEventListener("pointerup", soltar);
    });
    this.escenario.addEventListener("wheel", (ev) => { ev.preventDefault(); this.#zoom(this.r.z + (ev.deltaY < 0 ? 0.2 : -0.2)); }, { passive: false });
    this.escenario.addEventListener("keydown", (ev) => {
      const paso = ev.shiftKey ? 0.05 : 0.01;
      const k = { ArrowLeft: [-paso, 0], ArrowRight: [paso, 0], ArrowUp: [0, -paso], ArrowDown: [0, paso] }[ev.key];
      if (k) { ev.preventDefault(); this.r.x = acota(this.r.x + k[0], 0, 1); this.r.y = acota(this.r.y + k[1], 0, 1); this.#dibujar(); }
      if (ev.key === "+" || ev.key === "=") this.#zoom(this.r.z + 0.2);
      if (ev.key === "-") this.#zoom(this.r.z - 0.2);
    });
    contenido.querySelector("input[name=zoom]").addEventListener("input", (ev) => this.#zoom(Number(ev.target.value)));
    contenido.querySelector("[data-restablecer]").addEventListener("click", () => { this.r = { x: 0.5, y: 0.5, z: 1 }; this.#dibujar(); });
    contenido.querySelector("[data-cambiar]").addEventListener("click", () => this.#cambiarImagen());
    contenido.querySelector("[data-guardar]").addEventListener("click", () => this.#guardar());
  }

  async close(options) {
    this._observador?.disconnect();
    return super.close(options);
  }

  #zoom(z) { this.r.z = acota(Math.round(z * 100) / 100, 1, ZOOM_MAX); this.#dibujar(); }

  /** Marco sobre la imagen del escenario y las tres vistas previas. */
  #dibujar() {
    const b = this.base;
    if (!b?.naturalWidth) return;
    const caja = this.escenario.getBoundingClientRect();
    const k = Math.min(caja.width / b.naturalWidth, caja.height / b.naturalHeight);
    const w = b.naturalWidth * k, h = b.naturalHeight * k;
    Object.assign(b.style, { width: `${w}px`, height: `${h}px`, left: `${(caja.width - w) / 2}px`, top: `${(caja.height - h) / 2}px` });
    const lado = Math.min(w, h) / this.r.z;
    // El recuadro nunca se sale de la imagen: el centro se acota con él.
    this.r.x = acota(this.r.x, lado / 2 / w, 1 - lado / 2 / w);
    this.r.y = acota(this.r.y, lado / 2 / h, 1 - lado / 2 / h);
    const marco = this.escenario.querySelector(".marco");
    Object.assign(marco.style, { width: `${lado}px`, height: `${lado}px`, left: `${(caja.width - w) / 2 + this.r.x * w - lado / 2}px`, top: `${(caja.height - h) / 2 + this.r.y * h - lado / 2}px` });
    this.el.querySelector(".zoom-valor").textContent = `${this.r.z.toFixed(2)}×`;
    this.el.querySelector("input[name=zoom]").value = this.r.z;
    for (const v of this.el.querySelectorAll(".vistas img")) aplicar(v, this.r);
  }

  async #cambiarImagen() {
    const FP = filePicker();
    new FP({ type: "image", current: this.src, callback: (ruta) => { this.src = ruta; this.r = { x: 0.5, y: 0.5, z: 1 }; this.render(); } }).render({ force: true });
  }

  async #guardar() {
    const cambios = { [`flags.${MODULE_ID}.retrato`]: { x: Math.round(this.r.x * 1000) / 1000, y: Math.round(this.r.y * 1000) / 1000, z: this.r.z } };
    if (this.src !== this.actor.img) cambios.img = this.src;
    if (this.r.z === 1 && this.r.x === 0.5 && this.r.y === 0.5) { cambios[`flags.${MODULE_ID}.-=retrato`] = null; delete cambios[`flags.${MODULE_ID}.retrato`]; }
    await this.actor.update(cambios);
    this.close();
  }
}
