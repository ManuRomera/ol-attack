// MR · Manu Romera · Digital RPG Design — crédito discreto en Ajustes del juego.
// Archivo común a los paquetes de Foundry de Manu Romera: registra un botón «Créditos»
// en la sección del paquete dentro de Configurar ajustes. No toca la interfaz de juego.
const PKG = import.meta.url.match(/\/(?:systems|modules)\/([^/]+)\//)?.[1];
const LOGO = new URL("./mr-monograma-marfil.png", import.meta.url).href;
const V2 = foundry.applications?.api?.ApplicationV2;
const ES = () => (game.i18n?.lang ?? "es").startsWith("es");

function pkgData() {
  const p = game.modules?.get(PKG) ?? (game.system?.id === PKG ? game.system : null);
  return { title: p?.title ?? PKG, version: p?.version ?? "", url: p?.url ?? p?.manifest?.url ?? "" };
}

function html() {
  const p = pkgData();
  const es = ES();
  const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener" style="color:#C89B5A">${text}</a>`;
  return `<div style="background:#0B0D0E;color:#F2E8D5;padding:22px 20px 18px;text-align:center;font-family:var(--font-primary,sans-serif)">
    <img src="${LOGO}" alt="MR" style="height:64px;width:auto;border:0;margin:0 auto 10px;display:block">
    <div style="letter-spacing:.28em;font-size:15px;font-weight:600;text-transform:uppercase">Manu Romera</div>
    <div style="letter-spacing:.32em;font-size:10px;color:#7C8792;margin-top:3px;text-transform:uppercase">Digital RPG Design</div>
    <div style="height:1px;background:#B87333;opacity:.7;margin:16px auto 14px;width:56%"></div>
    <div style="font-size:13px;line-height:1.5">${es ? "Desarrollo para Foundry VTT de" : "Foundry VTT development of"}<br><b>${p.title}</b>${p.version ? ` <span style="color:#7C8792">v${p.version}</span>` : ""}</div>
    <div style="font-size:12px;margin-top:12px;line-height:1.7">${link("https://github.com/ManuRomera", es ? "Más sistemas y módulos" : "More systems and modules")}${p.url ? `<br>${link(p.url, es ? "Página del proyecto" : "Project page")}` : ""}</div>
  </div>`;
}

const Base = V2 ?? FormApplication;
class MrCredits extends Base {
  static DEFAULT_OPTIONS = { id: `mr-credits-${PKG}`, tag: "div", window: { title: "Manu Romera · Digital RPG Design", resizable: false }, position: { width: 360 } };
  static get defaultOptions() { return foundry.utils.mergeObject(super.defaultOptions, { id: `mr-credits-${PKG}`, title: "Manu Romera · Digital RPG Design", width: 360, popOut: true }); }
  async _renderHTML() { return html(); }
  _replaceHTML(result, content) { content.innerHTML = result; }
  async _renderInner() { return $(html()); }
}

if (PKG) {
  Hooks.once("init", () => {
    game.settings.registerMenu(PKG, "mrCredits", {
      name: "Manu Romera · Digital RPG Design",
      label: ES() ? "Créditos" : "Credits",
      hint: ES() ? "Quién ha desarrollado este paquete y dónde encontrar el resto." : "Who developed this package and where to find the rest.",
      icon: "fa-solid fa-star",
      type: MrCredits,
      restricted: false
    });
  });
}
