import { MODULE_ID, SETTING_PROFILE_WINDOW_STATE } from "../shared/constants.js";
import { LegacyFormApplication, LegacyDialog } from "../shared/compat.js";
import { getAvailableStatuses } from "../lib/statuses.js";
import {
  buildProfileCatalogEntries,
  clearItemActionProfileOverride,
  deleteGlobalActionProfile,
  getGlobalActionProfiles,
  replaceGlobalActionProfiles,
  saveGlobalActionProfile,
  setItemActionProfileOverride,
  mergeProfile,
  profileToActionConfigJson,
  actionConfigJsonToProfile,
  validateActionConfigJson
} from "../lib/action-profiles.js";
function escapeHtml(s) {
  return foundry.utils.escapeHTML(String(s ?? ""));
}
function deepClone(v) {
  return foundry.utils.deepClone(v);
}
function inferElementKind(entry = {}) {
  const raw = String(entry?.itemType || "").toLowerCase().trim();
  if (["spell"].includes(raw)) return "spell";
  if (["feat", "trait", "class", "subclass"].includes(raw)) return "trait";
  if (["weapon"].includes(raw)) return "weapon";
  if (["consumable"].includes(raw)) return "consumable";
  if (["equipment", "loot", "tool", "backpack", "container"].includes(raw)) return "item";
  return "custom";
}
const AI_ELEMENT_KIND_OPTIONS = [
  { value: "spell", label: "Hechizo" },
  { value: "trait", label: "Rasgo / dote / habilidad" },
  { value: "weapon", label: "Arma / ataque" },
  { value: "consumable", label: "Consumible" },
  { value: "item", label: "Objeto / equipo" },
  { value: "custom", label: "Homebrew / personalizado" }
];
const AI_PATTERN_OPTIONS = [
  { value: "auto", label: "Que la IA decida la mejor estructura" },
  { value: "damage", label: "Daño simple" },
  { value: "heal", label: "Curación simple" },
  { value: "choice", label: "Elección entre dos efectos" },
  { value: "effect", label: "Solo efecto / nota / estado" },
  { value: "workflow", label: "Workflow avanzado por pasos" }
];
const MODE_OPTIONS = ["auto","damage","heal","choice","effect","effectRoll","bonusdie","hidden","workflow"];
const SOURCE_OPTIONS = ["auto","activity","damage","healing","manual","none"];
const CARD_OPTIONS = ["auto","damage","heal","effect","choice","bonusdie","effectRoll"];
const CONSUME_OPTIONS = ["auto","none","uses","slot","both","manual","choice"];
const SIMPLE_AUTO_BOOL = ["auto","show","hide"];
const SAVE_AUTO_BOOL = ["auto","always","never"];
const ASSISTANT_MAX_STEP = 6;
const MODE_HELP = {
  auto: { title: "Automático", body: "Deja que OL Attack intente deducir el comportamiento por activities, daño, curación y usos.", example: "Ejemplo: un conjuro de daño normal o una curación estándar del sistema." },
  damage: { title: "Daño", body: "La acción se resolverá como daño y usará tarjeta de daño salvo que la fuerces a otra cosa.", example: "Ejemplo: Magic Missile, Fire Bolt o un rasgo que solo inflige daño." },
  heal: { title: "Curación", body: "La acción se resolverá como curación y aplicará tarjeta de curación.", example: "Ejemplo: Cure Wounds, Lay on Hands o una poción de curación." },
  choice: { title: "Elegir entre curar o dañar", body: "Antes de resolver, OL Attack pedirá si quieres usar el elemento para curar o para dañar.", example: "Ejemplo: Divine Spark / Chispa divina o cualquier homebrew con dos salidas posibles." },
  effect: { title: "Solo efecto", body: "La acción no tira daño ni curación; sirve para declarar un efecto narrativo o mecánico simple.", example: "Ejemplo: Rage, Reckless Attack, una postura o una dote declarativa." },
  effectRoll: { title: "Efecto con tirada", body: "La acción no es daño/curación normal, pero sí muestra una tirada propia.", example: "Ejemplo: un rasgo que lanza 1d6 para determinar intensidad, cargas o duración." },
  bonusdie: { title: "Dado extra", body: "La acción genera un dado o fórmula adicional para sumarlo a otra tirada o efecto.", example: "Ejemplo: Inspiración bárdica, Sneak extra o un bonus homebrew." },
  hidden: { title: "Oculto", body: "El elemento seguirá existiendo en la ficha, pero OL Attack no lo mostrará en la interfaz principal.", example: "Ejemplo: rasgos pasivos, basura de sistema o duplicados que no quieres ver." },
  workflow: { title: "Workflow JSON", body: "La acción se resolverá con un flujo avanzado definido en JSON. Permite secuencias, varias tiradas separadas, elecciones y estados.", example: "Ejemplo: tres tiradas de daño distintas asignables a objetivos distintos, o una acción que primero elige rama y luego aplica estado." }
};
const SOURCE_HELP = {
  auto: { title: "Automático", body: "Usa la información estructural del item. Es la mejor opción si el sistema ya lo tiene bien definido.", example: "Ejemplo: conjuros estándar de D&D5e 2024." },
  activity: { title: "Activity concreta", body: "Fuerza a usar una activity específica del item. Útil cuando el item tiene varias y una es la correcta.", example: "Ejemplo: una feature con varias acciones internas." },
  damage: { title: "damage.parts", body: "Ignora otras fuentes y toma el daño desde las partes de daño del item.", example: "Ejemplo: armas o rasgos con damage.parts bien definidos." },
  healing: { title: "healing.parts", body: "Ignora otras fuentes y toma la curación desde las partes de curación del item.", example: "Ejemplo: una curación homebrew que el sistema guarda solo en healing.parts." },
  manual: { title: "Fórmula manual", body: "Usa la fórmula que escribas tú, independientemente de lo que diga el item.", example: "Ejemplo: 1d8 + @mod o 2d6 radiant para homebrew mal estructurado." },
  none: { title: "Sin tirada", body: "La acción no debe sacar datos de daño/curación. Útil para efectos declarativos.", example: "Ejemplo: una postura o una activación puramente narrativa." }
};
const CARD_HELP = {
  auto: { title: "Automática", body: "OL Attack elige la tarjeta según el modo final de resolución.", example: "Recomendado para la mayoría de casos." },
  damage: { title: "Tarjeta de daño", body: "Fuerza a presentar la salida como tarjeta de daño.", example: "Útil si quieres visual consistente aunque la fuente sea manual." },
  heal: { title: "Tarjeta de curación", body: "Fuerza una tarjeta de curación.", example: "Útil para efectos de curación poco convencionales." },
  effect: { title: "Tarjeta de efecto", body: "Muestra una tarjeta declarativa sin daño/curación normal.", example: "Ideal para rasgos activables o estados." },
  choice: { title: "Tarjeta de elección", body: "Muestra la interfaz para elegir entre dos resoluciones posibles.", example: "Ideal para Divine Spark y mixtos similares." },
  bonusdie: { title: "Tarjeta de dado extra", body: "Presenta el resultado como bonus die.", example: "Ideal para inspiración o dados auxiliares." },
  effectRoll: { title: "Tarjeta de efecto con tirada", body: "Presenta una tirada que no es daño/curación estándar.", example: "Ideal para rasgos con d4, d6 o tablas simples." }
};
const CONSUME_HELP = {
  auto: { title: "Automático", body: "Deja que OL Attack use la lógica normal del sistema.", example: "Recomendado si el item ya consume bien por sí mismo." },
  none: { title: "No consumir", body: "Nunca gastará uses ni slots desde OL Attack.", example: "Útil para rasgos pasivos o pruebas sin gasto." },
  uses: { title: "Consumir uses", body: "Gasta usos del item y no slots.", example: "Ejemplo: Channel Divinity, Bardic Inspiration, dotes con usos." },
  slot: { title: "Consumir slot", body: "Gasta slot de conjuro y no uses del item.", example: "Ejemplo: un conjuro normal sin usos propios." },
  both: { title: "Consumir ambos", body: "Gasta uses del item y slot si corresponde.", example: "Útil en homebrew o recursos híbridos." },
  manual: { title: "Manual", body: "Reserva la lógica para casos especiales o seguimiento manual fuera del módulo.", example: "Útil si quieres controlar el gasto tú." },
  choice: { title: "Depende de la elección", body: "En modo choice, OL Attack decidirá el consumo según si eliges curar o dañar.", example: "Ejemplo: acciones mixtas con gasto distinto por cada rama." }
};
const SAVE_HELP = {
  auto: { title: "Automático", body: "OL Attack muestra o no la TS según lo que detecte en el item.", example: "Recomendado si el sistema ya lo tiene bien definido." },
  always: { title: "Mostrar TS", body: "Fuerza que aparezca salvación aunque la inferencia no lo vea claro.", example: "Útil para Toll the Dead o homebrew mal descrito." },
  never: { title: "Ocultar TS", body: "Nunca mostrará salvación desde la tarjeta.", example: "Útil para rasgos auxiliares o efectos que no deben pedirla." }
};
const DESCRIPTION_HELP = {
  auto: { title: "Automática", body: "OL Attack decide si mostrar descripción según el flujo actual.", example: "Recomendado si no te molesta el comportamiento estándar." },
  show: { title: "Mostrar descripción", body: "Fuerza a enseñar la descripción del item en la tarjeta cuando proceda.", example: "Útil para efectos narrativos o recordatorios de homebrew." },
  hide: { title: "Ocultar descripción", body: "Oculta la descripción aunque exista en el item.", example: "Útil si la tarjeta ya queda demasiado cargada." }
};
const SAVE_FAILURE_HELP = {
  autoDamageOff: { title: "Daño automático desactivado", body: "Si lo dejas apagado, el daño seguirá aplicándose manualmente desde la tarjeta del chat.", example: "Útil cuando quieres revisar cada objetivo antes de tocar sus PG." },
  autoDamageOn: { title: "Daño automático al fallar", body: "Cuando una TS falle, OL Attack aplicará automáticamente el daño configurado a ese objetivo concreto.", example: "Ejemplo: Garra de necrófago, trampas o conjuros donde fallar implica daño completo." },
  autoStatusOff: { title: "Estado automático desactivado", body: "No se aplicará ningún estado de forma automática al fallar la TS.", example: "Útil si quieres gestionar los estados a mano o si el efecto no deja condición." },
  autoStatusOn: { title: "Estado automático al fallar", body: "Cuando una TS falle, OL Attack aplicará el estado elegido a ese objetivo. Puedes elegir cualquier estado del sistema.", example: "Ejemplo: Paralizado para la garra del necrófago, Asustado o Envenenado según el efecto." }
};
const TUTORIAL_STEPS = [
  "Elige primero un elemento del catálogo. El sistema deduplica por clave robusta para que no tengas cien copias iguales.",
  "Usa el Asistente guiado si quieres decidirlo respondiendo preguntas sencillas en lenguaje natural.",
  "Revisa la pestaña Perfil si necesitas un ajuste fino: activity concreta, fórmula manual, consumo o claves especiales.",
  "Usa Variantes para casos especiales como Toll the Dead o para tocar el JSON si necesitas algo más fino.",
  "Guarda como perfil global si quieres que afecte a todas las copias equivalentes; guarda override exacto si solo quieres tocar ese item concreto."
];
function helperBlock(table, key) {
  return table[String(key || "auto")] || table.auto;
}
export class ActionProfileConfigApp extends LegacyFormApplication {
  constructor(options = {}) {
    super(options);
    this.state = deepClone(game.settings.get(MODULE_ID, SETTING_PROFILE_WINDOW_STATE) || {});
    this.catalog = [];
    this.filtered = [];
    this.selectedUid = this.state.selectedUid || null;
    this.activeTab = this.state.activeTab || "catalog";
    this.search = this.state.search || "";
    this.overridesOnly = !!this.state.overridesOnly;
    this.profileDrafts = {};
    this.matchKeyDrafts = {};
    this.assistantStepByUid = {};
    this.jsonTextDrafts = {};
    this.aiPromptDrafts = {};
  }
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "ol-action-profile-config",
      title: "OL Attack · Perfiles de acción",
      template: "modules/ol-attack/templates/action-profile-config.hbs",
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 620,
      resizable: true,
      classes: ["ol-attack", "ol-window-theme", "ol-action-profile-config"]
    });
  }
  _getSelectedEntry() {
    return this.catalog.find((e) => e.uid === this.selectedUid) || null;
  }
  _ensureProfileDraft(selected) {
    if (!selected) return mergeProfile({});
    if (!this.profileDrafts[selected.uid]) this.profileDrafts[selected.uid] = mergeProfile(selected.defaultProfile || {});
    return this.profileDrafts[selected.uid];
  }
  _setProfileDraft(uid, profile) {
    if (!uid) return;
    this.profileDrafts[uid] = mergeProfile(profile || {});
  }
  _getJsonDraft(selected) {
    if (!selected) return "{}";
    if (!this.jsonTextDrafts[selected.uid]) {
      const json = profileToActionConfigJson(this._ensureProfileDraft(selected), { itemName: selected.itemName, identifier: selected.identifier });
      this.jsonTextDrafts[selected.uid] = JSON.stringify(json, null, 2);
    }
    return this.jsonTextDrafts[selected.uid];
  }
  _setJsonDraft(uid, text) {
    if (!uid) return;
    this.jsonTextDrafts[uid] = String(text || "");
  }
  _getAiPromptMeta(selected) {
    if (!selected?.uid) {
      return {
        elementKind: "custom",
        pattern: "auto",
        request: "",
        constraints: "",
        includeCurrentJson: true,
        strictJsonOnly: true
      };
    }
    if (!this.aiPromptDrafts[selected.uid]) {
      this.aiPromptDrafts[selected.uid] = {
        elementKind: inferElementKind(selected),
        pattern: "auto",
        request: "",
        constraints: "",
        includeCurrentJson: true,
        strictJsonOnly: true
      };
    }
    return this.aiPromptDrafts[selected.uid];
  }
  _setAiPromptMeta(uid, patch = {}) {
    if (!uid) return;
    const current = this.aiPromptDrafts[uid] || {
      elementKind: "custom",
      pattern: "auto",
      request: "",
      constraints: "",
      includeCurrentJson: true,
      strictJsonOnly: true
    };
    this.aiPromptDrafts[uid] = {
      ...current,
      ...patch
    };
  }
  _buildAiPromptText(selected) {
    const meta = this._getAiPromptMeta(selected);
    const jsonBase = meta.includeCurrentJson ? this._getJsonDraft(selected) : "";
    const itemName = String(selected?.itemName || "Elemento sin nombre").trim();
    const itemType = String(selected?.itemType || meta.elementKind || "custom").trim();
    const identifier = String(selected?.identifier || "").trim();
    const actorName = String(selected?.actorName || "").trim();
    const strict = meta.strictJsonOnly
      ? "Devuélveme SOLO un bloque JSON válido. No añadas explicaciones, comentarios, markdown ni texto antes o después."
      : "Primero piensa la estructura, pero en la respuesta final dame el JSON válido y, debajo, una explicación muy breve de lo que has hecho.";
    const patternHints = {
      auto: "Elige entre mode auto, damage, heal, choice, effect, bonusdie o workflow según lo que mejor encaje.",
      damage: "Prioriza una estructura simple de daño si no hace falta workflow.",
      heal: "Prioriza una estructura simple de curación si no hace falta workflow.",
      choice: "Necesito una estructura con elección entre dos ramas o dos resultados posibles.",
      effect: "Necesito una estructura centrada en efecto, nota, estado o resolución narrativa/mecánica sin daño principal.",
      workflow: "Usa mode workflow y pasos encadenados; si hay varias resoluciones, ramas o selecciones, exprésalas con workflow.steps."
    };
    const request = String(meta.request || "").trim() || "Describe un comportamiento compatible con este elemento usando el esquema JSON de OL Attack.";
    const constraints = String(meta.constraints || "").trim();
    const lines = [
      "Quiero que actúes como diseñador técnico de JSON para el módulo OL Attack de Foundry VTT.",
      "Tu objetivo es devolver un JSON EXACTAMENTE compatible con el esquema del módulo, sin inventar claves ni valores fuera de los permitidos.",
      strict,
      "",
      "CONTEXTO DEL ELEMENTO:",
      `- Nombre: ${itemName}`,
      `- Tipo de elemento: ${itemType}`,
      identifier ? `- system.identifier actual: ${identifier}` : "- system.identifier actual: (vacío o no definido)",
      actorName ? `- Actor relacionado: ${actorName}` : "- Actor relacionado: (no aplica)",
      `- Clase funcional deseada: ${meta.elementKind}`,
      "",
      "LO QUE QUIERO QUE HAGA EL ELEMENTO:",
      request,
      constraints ? `
RESTRICCIONES ADICIONALES:
${constraints}` : "",
      `
PATRÓN SUGERIDO:
${patternHints[meta.pattern] || patternHints.auto}`,
      "",
      "REGLAS DEL ESQUEMA QUE DEBES RESPETAR:",
      '- engine debe ser exactamente "ol-attack.action-config".',
      "- version debe ser exactamente 1.",
      "- Claves raíz permitidas: engine, version, mode, rollSource, activityId, manualFormula, manualType, cardType, consume, choiceConsumeHeal, choiceConsumeDamage, showSave, showDescription, effectNoteTitle, effectNoteText, autoApplyDamageOnFailedSave, autoApplyStatusOnFailedSave, saveFailStatusId, hidden, specialFeatureKey, specialCounterKey, variants, workflow, itemName, identifier.",
      "- mode permitido: auto, damage, heal, choice, effect, effectRoll, bonusdie, hidden, workflow.",
      "- rollSource permitido: auto, activity, damage, healing, manual, none.",
      "- cardType permitido: auto, damage, heal, effect, choice, bonusdie, effectRoll.",
      "- consume permitido: auto, none, uses, slot, both, manual, choice.",
      "- showSave permitido: auto, always, never.",
      "- showDescription permitido: auto, show, hide.",
      "- Si mode es workflow, workflow debe incluir targeting y steps.",
      "- targeting.default permitido: selected, chooseOne, self, none, targetIndex.",
      "- Tipos de paso permitidos dentro de workflow.steps: damageRoll, healRoll, effectText, applyStatus, removeStatus, choice, bonusDie.",
      "- En pasos damageRoll, healRoll y bonusDie usa formula obligatoria y damageType cuando aplique.",
      "- En applyStatus y removeStatus usa statusId.",
      "- En choice usa branches con ramas que contengan label, description y steps.",
      "- No inventes otras claves como cooldown, range, duration, saveDC, area, template, macros, flags o similares si no están permitidas por este esquema.",
      "",
      "CRITERIOS DE DISEÑO:",
      "- Si el comportamiento cabe en un modo simple, no uses workflow innecesariamente.",
      "- Si hay varias tiradas separadas, varias ramas o selección de objetivos independiente, usa workflow.",
      "- Si hace falta una nota visible, usa effectNoteTitle y effectNoteText.",
      "- Si hay aplicación automática de estado o daño tras una salvación fallida, configúralo con autoApplyDamageOnFailedSave, autoApplyStatusOnFailedSave y saveFailStatusId.",
      "- Mantén el JSON limpio y minimalista: solo las claves necesarias.",
      "",
      "FORMATO DE RESPUESTA:",
      "- Responde con JSON válido listo para pegar en el campo JSON avanzado del módulo.",
      "- No uses comillas tipográficas.",
      "- No uses comentarios // ni /* */.",
      "- No encierres la respuesta entre ```json.",
    ];
    if (jsonBase) {
      lines.push(
        "",
        "USA ESTE JSON ACTUAL COMO PUNTO DE PARTIDA Y MODIFÍCALO SOLO EN LO NECESARIO:",
        jsonBase
      );
    }
    return lines.filter(Boolean).join("\n");
  }
  async _copyTextToClipboard(text, fallbackTitle = "Copiar texto") {
    const payload = String(text || "");
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
        return true;
      }
    } catch (_) {}
    try {
      const area = document.createElement("textarea");
      area.value = payload;
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.focus();
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      if (ok) return true;
    } catch (_) {}
    await new LegacyDialog({
      title: fallbackTitle,
      content: `<div><p>No pude copiarlo automáticamente. Copia este texto manualmente.</p><textarea style="width:100%;height:360px;">${escapeHtml(payload)}</textarea></div>`,
      buttons: { ok: { label: "Cerrar" } }
    }, { width: 760 }).render(true);
    return false;
  }
  _getMatchKey(selected) {
    if (!selected) return "";
    if (!this.matchKeyDrafts[selected.uid]) {
      this.matchKeyDrafts[selected.uid] = selected.matchKey || selected.primaryKey || selected.candidates?.[0]?.key || "";
    }
    return this.matchKeyDrafts[selected.uid];
  }
  _getAssistantStep(selected) {
    const uid = selected?.uid;
    const step = Number(this.assistantStepByUid[uid] || 1);
    return Math.min(ASSISTANT_MAX_STEP, Math.max(1, step));
  }
  _setAssistantStep(selected, step) {
    if (!selected?.uid) return;
    this.assistantStepByUid[selected.uid] = Math.min(ASSISTANT_MAX_STEP, Math.max(1, Number(step) || 1));
  }
  _buildVariantPreset(profile) {
    const toll = profile?.variants?.targetWoundedFirstPart;
    if (toll?.enabled) return "toll-dead-wounded";
    return "none";
  }
  async getData() {
    this.catalog = buildProfileCatalogEntries();
    const q = String(this.search || "").toLowerCase().trim();
    this.filtered = this.catalog.filter((e) => {
      if (this.overridesOnly && !(e.hasOverride || e.resolvedSource === "global-profile")) return false;
      if (!q) return true;
      return [e.itemName, e.itemType, e.identifier, e.actorName, e.matchKey, e.resolvedMode].some((v) => String(v || "").toLowerCase().includes(q));
    });
    const selected = this.catalog.find((e) => e.uid === this.selectedUid) || this.filtered[0] || this.catalog[0] || null;
    this.selectedUid = selected?.uid || null;
    if (!selected) {
      return { hasSelection: false, catalog: [], state: this.state, tutorialSteps: TUTORIAL_STEPS };
    }
    const profile = this._ensureProfileDraft(selected);
    const globalProfiles = getGlobalActionProfiles();
    const matchKey = this._getMatchKey(selected);
    const globalProfile = globalProfiles?.[matchKey] ? mergeProfile(globalProfiles[matchKey]) : null;
    const assistantStep = this._getAssistantStep(selected);
    return {
      hasSelection: true,
      catalog: this.filtered.map((e) => ({
        ...e,
        isSelected: e.uid === selected.uid,
        resolvedLabel: e.resolvedSource === "item-override" ? "Override" : e.resolvedSource === "global-profile" ? "Global" : e.resolvedSource === "legacy-name" ? "Legacy" : "Auto",
        searchText: [e.itemName, e.itemType, e.identifier, e.actorName, e.matchKey, e.resolvedMode].join(' ').toLowerCase()
      })),
      selected,
      profile,
      globalProfile,
      activeTab: this.activeTab,
      search: this.search,
      overridesOnly: this.overridesOnly,
      modeOptions: MODE_OPTIONS,
      sourceOptions: SOURCE_OPTIONS,
      cardOptions: CARD_OPTIONS,
      consumeOptions: CONSUME_OPTIONS,
      saveOptions: SAVE_AUTO_BOOL,
      descriptionOptions: SIMPLE_AUTO_BOOL,
      variantsJson: JSON.stringify(profile.variants || {}, null, 2),
      tutorialSteps: TUTORIAL_STEPS,
      matchKey,
      assistantStep,
      assistantMaxStep: ASSISTANT_MAX_STEP,
      assistantVariantPreset: this._buildVariantPreset(profile),
      modeHelp: helperBlock(MODE_HELP, profile.mode),
      sourceHelp: helperBlock(SOURCE_HELP, profile.rollSource),
      cardHelp: helperBlock(CARD_HELP, profile.cardType),
      consumeHelp: helperBlock(CONSUME_HELP, profile.consume),
      saveHelp: helperBlock(SAVE_HELP, profile.showSave),
      descriptionHelp: helperBlock(DESCRIPTION_HELP, profile.showDescription),
      saveFailureDamageHelp: profile.autoApplyDamageOnFailedSave ? SAVE_FAILURE_HELP.autoDamageOn : SAVE_FAILURE_HELP.autoDamageOff,
      saveFailureStatusHelp: profile.autoApplyStatusOnFailedSave ? SAVE_FAILURE_HELP.autoStatusOn : SAVE_FAILURE_HELP.autoStatusOff,
      statusOptions: getAvailableStatuses().map((status) => ({ value: status.id, label: status.label })),
      aiElementKinds: AI_ELEMENT_KIND_OPTIONS,
      aiPatternOptions: AI_PATTERN_OPTIONS,
      aiPromptMeta: this._getAiPromptMeta(selected),
      aiPromptText: this._buildAiPromptText(selected),
      actionJsonText: this._getJsonDraft(selected),
      actionJsonValidation: validateActionConfigJson(profileToActionConfigJson(profile, { itemName: selected.itemName, identifier: selected.identifier }), profile)
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
        selectedUid: this.selectedUid,
        search: this.search,
        overridesOnly: this.overridesOnly,
        activeTab: this.activeTab
      };
    } catch (_) {}
  }
  async _render(force = false, options = {}) {
    this._snapshotWindowState();
    const st = this.state || {};
    if (!Number.isFinite(options.left) && Number.isFinite(st.left)) options.left = st.left;
    if (!Number.isFinite(options.top) && Number.isFinite(st.top)) options.top = st.top;
    if (!Number.isFinite(options.width) && Number.isFinite(st.width)) options.width = st.width;
    if (!Number.isFinite(options.height) && Number.isFinite(st.height)) options.height = st.height;
    return super._render(force, options);
  }
  activateListeners(html) {
    super.activateListeners(html);
    html.find(".ol-apc-tab").on("click", (ev) => {
      ev.preventDefault();
      this.activeTab = String(ev.currentTarget.dataset.tab || "catalog");
      this._persistState();
      this.render(false);
    });
    html.find(".ol-apc-search").on("input", (ev) => {
      this.search = String(ev.currentTarget.value || "");
      this._applyListFilter(html);
    });
    html.find(".ol-apc-overrides-only").on("change", (ev) => {
      this.overridesOnly = !!ev.currentTarget.checked;
      this._applyListFilter(html);
    });
    html.find(".ol-apc-row").on("click", (ev) => {
      ev.preventDefault();
      this.selectedUid = String(ev.currentTarget.dataset.uid || "");
      this._persistState();
      this.render(false);
    });
    html.find(".ol-apc-profile-form").on("change", "select, input, textarea", () => this._syncProfileDraftFromForm(html));
    html.find(".ol-apc-profile-form").on("input", 'input[type="text"], textarea', () => this._syncProfileDraftFromForm(html));
    html.find('.ol-apc-json-editor').on('input', (ev) => {
      const selected = this._getSelectedEntry();
      if (!selected?.uid) return;
      this._setJsonDraft(selected.uid, ev.currentTarget.value || '');
      html.find('[name="aiPromptText"]').val(this._buildAiPromptText(selected));
    });
    html.find('.ol-apc-ai-field').on('change input', (ev) => {
      const selected = this._getSelectedEntry();
      if (!selected?.uid) return;
      const $root = html;
      this._setAiPromptMeta(selected.uid, {
        elementKind: String($root.find('[name="aiElementKind"]').val() || inferElementKind(selected)),
        pattern: String($root.find('[name="aiPattern"]').val() || 'auto'),
        request: String($root.find('[name="aiRequest"]').val() || ''),
        constraints: String($root.find('[name="aiConstraints"]').val() || ''),
        includeCurrentJson: !!$root.find('[name="aiIncludeCurrentJson"]').is(':checked'),
        strictJsonOnly: !!$root.find('[name="aiStrictJsonOnly"]').is(':checked')
      });
      $root.find('[name="aiPromptText"]').val(this._buildAiPromptText(selected));
    });
    html.find('.ol-apc-ai-generate').on('click', (ev) => {
      ev.preventDefault();
      const selected = this._getSelectedEntry();
      if (!selected?.uid) return;
      html.find('[name="aiPromptText"]').val(this._buildAiPromptText(selected));
      ui.notifications.info('Prompt IA actualizado.');
    });
    html.find('.ol-apc-ai-copy').on('click', async (ev) => {
      ev.preventDefault();
      const selected = this._getSelectedEntry();
      const ok = await this._copyTextToClipboard(this._buildAiPromptText(selected), 'Copiar prompt para IA');
      if (ok) ui.notifications.info('Prompt copiado al portapapeles.');
    });
    html.find('.ol-apc-ai-copy-json').on('click', async (ev) => {
      ev.preventDefault();
      const selected = this._getSelectedEntry();
      const ok = await this._copyTextToClipboard(this._getJsonDraft(selected), 'Copiar JSON actual');
      if (ok) ui.notifications.info('JSON actual copiado al portapapeles.');
    });
    html.find('.ol-apc-json-validate').on('click', (ev) => {
      ev.preventDefault();
      const selected = this._getSelectedEntry();
      const text = this._getJsonDraft(selected);
      try {
        const parsed = JSON.parse(text || '{}');
        const check = validateActionConfigJson(parsed, this._ensureProfileDraft(selected));
        if (!check.ok) return ui.notifications.error(`JSON inválido: ${check.errors.join(' | ')}`);
        const msg = check.warnings?.length ? `JSON válido con avisos: ${check.warnings.join(' | ')}` : 'JSON válido.';
        ui.notifications.info(msg);
      } catch (err) {
        ui.notifications.error(`JSON inválido: ${err?.message || err}`);
      }
    });
    html.find('.ol-apc-json-apply').on('click', (ev) => {
      ev.preventDefault();
      const selected = this._getSelectedEntry();
      if (!selected?.uid) return;
      const text = this._getJsonDraft(selected);
      try {
        const parsed = JSON.parse(text || '{}');
        const check = validateActionConfigJson(parsed, this._ensureProfileDraft(selected));
        if (!check.ok) return ui.notifications.error(`JSON inválido: ${check.errors.join(' | ')}`);
        this._setProfileDraft(selected.uid, actionConfigJsonToProfile(check.normalized, this._ensureProfileDraft(selected)));
        this._setJsonDraft(selected.uid, JSON.stringify(check.normalized, null, 2));
        this.render(false);
        ui.notifications.info('JSON aplicado al perfil. Ya puedes guardarlo como perfil global u override exacto.');
      } catch (err) {
        ui.notifications.error(`No se pudo aplicar el JSON: ${err?.message || err}`);
      }
    });
    html.find('.ol-apc-json-export').on('click', (ev) => {
      ev.preventDefault();
      const selected = this._getSelectedEntry();
      const text = this._getJsonDraft(selected);
      const fileName = `${String(selected?.itemName || 'ol-attack').replace(/[^a-z0-9-_]+/gi, '_').toLowerCase()}.json`;
      const saver = globalThis.saveDataToFile || foundry?.utils?.saveDataToFile;
      if (!saver) return ui.notifications.error('No existe saveDataToFile en este entorno.');
      saver(text, 'application/json', fileName);
    });
    html.find('.ol-apc-json-rebuild').on('click', (ev) => {
      ev.preventDefault();
      const selected = this._getSelectedEntry();
      if (!selected?.uid) return;
      const json = profileToActionConfigJson(this._ensureProfileDraft(selected), { itemName: selected.itemName, identifier: selected.identifier });
      this._setJsonDraft(selected.uid, JSON.stringify(json, null, 2));
      this.render(false);
    });
    html.find('.ol-apc-json-example').on('click', (ev) => {
      ev.preventDefault();
      const selected = this._getSelectedEntry();
      if (!selected?.uid) return;
      const example = {
        engine: 'ol-attack.action-config',
        version: 1,
        mode: 'workflow',
        cardType: 'auto',
        consume: 'auto',
        workflow: {
          targeting: { default: 'selected', min: 1, max: 3 },
          steps: [
            { id: 'beam-1', type: 'damageRoll', label: 'Rayo 1', formula: '1d8', damageType: 'radiant', targeting: 'chooseOne' },
            { id: 'beam-2', type: 'damageRoll', label: 'Rayo 2', formula: '1d8', damageType: 'radiant', targeting: 'chooseOne' },
            { id: 'beam-3', type: 'damageRoll', label: 'Rayo 3', formula: '1d8', damageType: 'radiant', targeting: 'chooseOne' }
          ]
        }
      };
      this._setJsonDraft(selected.uid, JSON.stringify(example, null, 2));
      this.render(false);
    });
    html.find('.ol-apc-json-file').on('change', async (ev) => {
      const selected = this._getSelectedEntry();
      const file = ev.currentTarget.files?.[0];
      if (!selected?.uid || !file) return;
      const text = await file.text();
      this._setJsonDraft(selected.uid, text);
      this.render(false);
    });
    html.find('.ol-apc-json-import-trigger').on('click', (ev) => {
      ev.preventDefault();
      html.find('.ol-apc-json-file').trigger('click');
    });
    html.find(".ol-apc-matchkey").on("change", (ev) => {
      const selected = this._getSelectedEntry();
      if (!selected?.uid) return;
      this.matchKeyDrafts[selected.uid] = String(ev.currentTarget.value || "").trim();
    });
    html.find(".ol-apc-wizard").on("change", "select, input", () => {
      this._applyAssistantToDraft(html);
      this.render(false);
    });
    html.find(".ol-apc-assistant-prev").on("click", (ev) => {
      ev.preventDefault();
      const selected = this._getSelectedEntry();
      this._applyAssistantToDraft(html);
      this._setAssistantStep(selected, this._getAssistantStep(selected) - 1);
      this.render(false);
    });
    html.find(".ol-apc-assistant-next").on("click", (ev) => {
      ev.preventDefault();
      const selected = this._getSelectedEntry();
      this._applyAssistantToDraft(html);
      this._setAssistantStep(selected, this._getAssistantStep(selected) + 1);
      this.render(false);
    });
    html.find(".ol-apc-assistant-apply").on("click", (ev) => {
      ev.preventDefault();
      this._applyAssistantToDraft(html);
      this.activeTab = "profile";
      this.render(false);
      ui.notifications.info("Asistente aplicado al perfil. Revisa los campos y guarda cuando lo tengas claro.");
    });
    html.find(".ol-apc-variant-preset").on("change", () => this._syncProfileDraftFromForm(html));
    html.find(".ol-apc-save-global").on("click", async (ev) => {
      ev.preventDefault();
      this._syncProfileDraftFromForm(html);
      const selected = this._getSelectedEntry();
      const payload = mergeProfile(this._ensureProfileDraft(selected));
      const key = this._getMatchKey(selected);
      if (!key) return ui.notifications.warn("Selecciona una clave robusta para guardar el perfil global.");
      await saveGlobalActionProfile(key, payload);
      ui.notifications.info(`Perfil global guardado: ${key}`);
      this.render(false);
    });
    html.find(".ol-apc-save-override").on("click", async (ev) => {
      ev.preventDefault();
      this._syncProfileDraftFromForm(html);
      const selected = this._getSelectedEntry();
      if (!selected?.itemUuid) return ui.notifications.warn("No hay un ítem concreto para guardar override exacto.");
      const item = await fromUuid(selected.itemUuid).catch(() => null);
      if (!item) return ui.notifications.warn("No se pudo localizar el ítem para guardar override.");
      await setItemActionProfileOverride(item, mergeProfile(this._ensureProfileDraft(selected)));
      ui.notifications.info(`Override exacto guardado en ${item.name}.`);
      this.render(false);
    });
    html.find(".ol-apc-clear-override").on("click", async (ev) => {
      ev.preventDefault();
      const selected = this._getSelectedEntry();
      if (!selected?.itemUuid) return ui.notifications.warn("No hay un ítem concreto para limpiar el override.");
      const item = await fromUuid(selected.itemUuid).catch(() => null);
      if (!item) return ui.notifications.warn("No se pudo localizar el ítem para limpiar override.");
      await clearItemActionProfileOverride(item);
      ui.notifications.info(`Override eliminado en ${item.name}.`);
      this.profileDrafts[selected.uid] = mergeProfile(selected.defaultProfile || {});
      this.render(false);
    });
    html.find(".ol-apc-delete-global").on("click", async (ev) => {
      ev.preventDefault();
      const selected = this._getSelectedEntry();
      const key = this._getMatchKey(selected);
      if (!key) return ui.notifications.warn("No hay clave global seleccionada.");
      await deleteGlobalActionProfile(key);
      ui.notifications.info(`Perfil global eliminado: ${key}`);
      this.render(false);
    });
    html.find(".ol-apc-export").on("click", async (ev) => {
      ev.preventDefault();
      const data = JSON.stringify(getGlobalActionProfiles(), null, 2);
      await new LegacyDialog({
        title: "Exportar perfiles",
        content: `<textarea style="width:100%;height:420px;">${escapeHtml(data)}</textarea>`,
        buttons: { ok: { label: "Cerrar" } }
      }, { width: 720 }).render(true);
    });
    html.find(".ol-apc-import").on("click", async (ev) => {
      ev.preventDefault();
      const content = `<div><p>Pega aquí el JSON exportado.</p><textarea name="json" style="width:100%;height:420px;"></textarea></div>`;
      new LegacyDialog({
        title: "Importar perfiles",
        content,
        buttons: {
          import: {
            label: "Importar",
            callback: async (dlgHtml) => {
              try {
                const parsed = JSON.parse(String(dlgHtml.find('[name="json"]').val() || "{}"));
                await replaceGlobalActionProfiles(parsed || {});
                ui.notifications.info("Perfiles importados.");
                this.render(false);
              } catch (err) {
                ui.notifications.error(`JSON inválido: ${err?.message || err}`);
              }
            }
          },
          cancel: { label: "Cancelar" }
        },
        default: "import"
      }, { width: 720 }).render(true);
    });
    this._applyListFilter(html);
    html.find(".ol-apc-reset-all").on("click", async (ev) => {
      ev.preventDefault();
      await replaceGlobalActionProfiles({});
      ui.notifications.info("Registro global de perfiles reseteado.");
      this.render(false);
    });
  }
  _readProfileForm(html, baseProfile = null) {
    const base = mergeProfile(baseProfile || {});
    const read = (name) => String(html.find(`[name="${name}"]`).val() || "").trim();
    const tollEnabled = !!html.find('[name="tollEnabled"]').is(":checked");
    const tollFrom = read("tollFrom") || "d8";
    const tollTo = read("tollTo") || "d12";
    const variantPreset = read("variantPreset") || this._buildVariantPreset(base);
    let variants = deepClone(base.variants || {});
    const rawVariants = read("variantsJson");
    if (rawVariants) {
      try {
        variants = JSON.parse(rawVariants);
      } catch (err) {
        ui.notifications.warn(`No se pudieron leer las variantes: ${err?.message || err}`);
      }
    }
    if (variantPreset === "toll-dead-wounded" || tollEnabled) {
      variants = {
        ...(variants || {}),
        targetWoundedFirstPart: {
          enabled: true,
          from: tollFrom,
          to: tollTo
        }
      };
    } else if (variants?.targetWoundedFirstPart) {
      delete variants.targetWoundedFirstPart;
    }
    let jsonConfig = deepClone(base.jsonConfig || null);
    const selected = this._getSelectedEntry();
    if (selected?.uid && this.jsonTextDrafts[selected.uid]) {
      try {
        const parsedJson = JSON.parse(this.jsonTextDrafts[selected.uid]);
        const checked = validateActionConfigJson(parsedJson, base);
        if (checked.ok) jsonConfig = checked.normalized;
      } catch (_) {}
    }
    return mergeProfile({
      ...base,
      mode: read("mode") || base.mode || "auto",
      rollSource: read("rollSource") || base.rollSource || "auto",
      activityId: read("activityId") || base.activityId,
      manualFormula: read("manualFormula") || base.manualFormula,
      manualType: read("manualType") || base.manualType || "force",
      cardType: read("cardType") || base.cardType || "auto",
      consume: read("consume") || base.consume || "auto",
      choiceConsumeHeal: read("choiceConsumeHeal") || base.choiceConsumeHeal || "auto",
      choiceConsumeDamage: read("choiceConsumeDamage") || base.choiceConsumeDamage || "auto",
      showSave: read("showSave") || base.showSave || "auto",
      showDescription: read("showDescription") || base.showDescription || "auto",
      autoApplyDamageOnFailedSave: !!html.find('[name="autoApplyDamageOnFailedSave"]').is(":checked"),
      autoApplyStatusOnFailedSave: !!html.find('[name="autoApplyStatusOnFailedSave"]').is(":checked"),
      saveFailStatusId: read("saveFailStatusId") || "",
      effectNoteTitle: read("effectNoteTitle") || base.effectNoteTitle || "",
      effectNoteText: read("effectNoteText") || base.effectNoteText || "",
      hidden: !!html.find('[name="hidden"]').is(":checked"),
      specialFeatureKey: read("specialFeatureKey") || base.specialFeatureKey,
      specialCounterKey: read("specialCounterKey") || base.specialCounterKey,
      variants,
      jsonConfig
    });
  }
  _syncProfileDraftFromForm(html) {
    const selected = this._getSelectedEntry();
    if (!selected?.uid) return;
    const next = this._readProfileForm(html, this._ensureProfileDraft(selected));
    this._setProfileDraft(selected.uid, next);
  }
  _applyAssistantToDraft(html) {
    const selected = this._getSelectedEntry();
    if (!selected?.uid) return;
    const current = this._ensureProfileDraft(selected);
    const read = (name) => String(html.find(`[name="${name}"]`).val() || "").trim();
    const patch = {
      mode: read("wizMode") || current.mode,
      rollSource: read("wizRollSource") || current.rollSource,
      cardType: read("wizCardType") || current.cardType,
      consume: read("wizConsume") || current.consume,
      showSave: read("wizShowSave") || current.showSave,
      showDescription: read("wizShowDescription") || current.showDescription,
      hidden: !!html.find('[name="wizHidden"]').is(":checked")
    };
    const preset = read("wizVariantPreset");
    const merged = mergeProfile({ ...current, ...patch });
    if (preset === "toll-dead-wounded") {
      merged.variants = {
        ...(merged.variants || {}),
        targetWoundedFirstPart: {
          enabled: true,
          from: "d8",
          to: "d12"
        }
      };
    } else if (merged.variants?.targetWoundedFirstPart) {
      delete merged.variants.targetWoundedFirstPart;
    }
    this._setProfileDraft(selected.uid, merged);
  }
  _applyListFilter(html) {
    const query = String(this.search || "").toLowerCase().trim();
    const rows = html.find(".ol-apc-row");
    let visible = 0;
    rows.each((_, el) => {
      const $el = $(el);
      const hay = String($el.data("search") || "").toLowerCase();
      const hasOverride = String($el.data("hasOverride") || "0") === "1";
      const hasGlobal = String($el.data("hasGlobal") || "0") === "1";
      const showByOverride = !this.overridesOnly || hasOverride || hasGlobal;
      const showByQuery = !query || hay.includes(query);
      const show = showByOverride && showByQuery;
      $el.toggle(show);
      if (show) visible += 1;
    });
    const empty = html.find('.ol-apc-list .ol-apc-empty');
    if (!visible) {
      if (!empty.length) html.find('.ol-apc-list').append('<div class="ol-apc-empty ol-apc-empty-live">No hay elementos que coincidan con el filtro.</div>');
    } else {
      html.find('.ol-apc-list .ol-apc-empty-live').remove();
    }
  }
  async _updateObject() {}
  async close(options = {}) {
    this._persistState();
    return super.close(options);
  }
  async _persistState() {
    this._snapshotWindowState();
    const pos = this.position || {};
    this.state = {
      left: Number.isFinite(pos.left) ? pos.left : this.state.left,
      top: Number.isFinite(pos.top) ? pos.top : this.state.top,
      width: Number.isFinite(pos.width) ? pos.width : this.state.width,
      height: Number.isFinite(pos.height) ? pos.height : this.state.height,
      selectedUid: this.selectedUid,
      search: this.search,
      overridesOnly: this.overridesOnly,
      activeTab: this.activeTab
    };
    await game.settings.set(MODULE_ID, SETTING_PROFILE_WINDOW_STATE, this.state);
  }
}
