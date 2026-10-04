/**
 * Memoria de ventanas. Cada ventana del módulo recuerda, por usuario y mundo, su posición y
 * tamaño, la pestaña activa, las secciones plegadas y el desplazamiento. Una ventana nueva hereda
 * el último tamaño usado por su clase.
 *
 * Vive en localStorage: es una preferencia de este navegador, no un dato del mundo (sustituye al
 * antiguo ajuste `windowLayoutState`, que escribía en la base de datos a cada arrastre).
 */
const PREFIJO = "ol-attack.ventana.";
const CAMPOS = ["left", "top", "width", "height"];

const clave = (id) => `${PREFIJO}${game.world?.id}.${game.user?.id}.${id}`;

export function leer(id) {
  try { return JSON.parse(localStorage.getItem(clave(id))) ?? {}; }
  catch { return {}; }
}

export function recordar(id, cambios) {
  try { localStorage.setItem(clave(id), JSON.stringify({ ...leer(id), ...cambios })); }
  catch (error) { console.warn("ol-attack | No se pudo guardar la ventana", error); }
}

export function olvidarTodo() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith(PREFIJO)) localStorage.removeItem(k);
  }
}

const numericos = (pos, campos) =>
  Object.fromEntries(campos.filter((c) => Number.isFinite(pos?.[c])).map((c) => [c, Math.round(pos[c])]));

/** Conserva el estado de una ventana entre sesiones y repintados. */
export function ConMemoria(Base) {
  return class extends Base {
    static CAMPOS_MEMORIA = CAMPOS;

    constructor(options = {}) {
      const Clase = new.target;
      const id = options.memoria ?? Clase.MEMORIA ?? Clase.name;
      const propia = leer(id);
      const heredada = propia.posicion ? {} : numericos(leer(`clase.${Clase.name}`).posicion, ["width", "height"]);
      const guardada = numericos(propia.posicion, Clase.CAMPOS_MEMORIA);
      super({ ...options, position: { ...options.position, ...heredada, ...guardada } });
      this._memoria = { id, secciones: propia.secciones ?? {}, scroll: propia.scroll ?? {} };
      if (propia.pestanas) Object.assign(this.tabGroups, propia.pestanas);
    }

    /** El motor llama aquí tras cada setPosition. */
    _onPosition(position) {
      super._onPosition?.(position);
      if (!this.rendered) return;
      clearTimeout(this._memoria.temporizador);
      this._memoria.temporizador = setTimeout(() => this.#guardarPosicion(), 250);
    }

    #guardarPosicion() {
      // Minimizada, la altura es la de la barra de título: solo vale la posición.
      const campos = this.minimized ? ["left", "top"] : this.constructor.CAMPOS_MEMORIA;
      const pos = numericos(this.position, campos);
      recordar(this._memoria.id, { posicion: { ...leer(this._memoria.id).posicion, ...pos } });
      if (!this.minimized) recordar(`clase.${this.constructor.name}`, { posicion: numericos(this.position, ["width", "height"]) });
    }

    changeTab(tab, group, opciones) {
      super.changeTab(tab, group, opciones);
      recordar(this._memoria.id, { pestanas: { ...this.tabGroups } });
    }

    /** ¿Está abierta esta sección plegable? `porDefecto` si nunca se tocó. */
    abierto(seccion, porDefecto = true) {
      return this._memoria.secciones[seccion] ?? porDefecto;
    }

    async _onRender(context, options) {
      await super._onRender(context, options);
      for (const d of this.element.querySelectorAll("details[data-memoria]")) {
        d.addEventListener("toggle", () => {
          this._memoria.secciones[d.dataset.memoria] = d.open;
          recordar(this._memoria.id, { secciones: this._memoria.secciones });
        });
      }
      if (options.isFirstRender) {
        for (const [selector, top] of Object.entries(this._memoria.scroll)) {
          const el = this.element.querySelector(selector);
          if (el) el.scrollTop = top;
        }
      }
    }

    /**
     * La mesa es compartida: otro usuario puede provocar un repintado mientras escribes.
     * El motor devuelve el foco, pero no el texto aún sin guardar; aquí se conserva.
     */
    _preSyncPartState(partId, nuevo, anterior, estado) {
      super._preSyncPartState?.(partId, nuevo, anterior, estado);
      const campo = document.activeElement;
      if (!anterior.contains(campo) || !campo.name || !campo.matches("input[type=text], input[type=number], textarea")) return;
      estado.escrito = { selector: `${campo.tagName}[name="${campo.name}"]`, valor: campo.value, desde: campo.selectionStart, hasta: campo.selectionEnd };
    }

    _syncPartState(partId, nuevo, anterior, estado) {
      super._syncPartState?.(partId, nuevo, anterior, estado);
      const campo = estado.escrito && nuevo.querySelector(estado.escrito.selector);
      if (!campo) return;
      campo.value = estado.escrito.valor;
      campo.focus();
      try { campo.setSelectionRange(estado.escrito.desde, estado.escrito.hasta); } catch { /* type=number no admite selección */ }
    }

    async close(options) {
      if (this.rendered) {
        const scroll = {};
        for (const selector of this.constructor.SCROLL_MEMORIA ?? []) {
          const el = this.element.querySelector(selector);
          if (el) scroll[selector] = el.scrollTop;
        }
        this.#guardarPosicion();
        recordar(this._memoria.id, { scroll });
      }
      return super.close(options);
    }
  };
}
