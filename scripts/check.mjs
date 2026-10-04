// Comprobaciones del módulo: manifiesto, etiqueta de versión, idiomas y rastros de la API V1.
// Uso: node scripts/check.mjs   (en CI, RELEASE_TAG=vX.Y.Z valida que coincida con module.json)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const raiz = new URL("..", import.meta.url).pathname;
const leer = (r) => readFileSync(join(raiz, r), "utf8");
const fallos = [];

const m = JSON.parse(leer("module.json"));
if (m.id !== "ol-attack") fallos.push(`module.json: id inesperado (${m.id})`);
const tag = process.env.RELEASE_TAG;
if (tag && tag !== `v${m.version}`) fallos.push(`La etiqueta ${tag} no coincide con module.json (${m.version})`);
for (const campo of ["manifest", "download", "url"]) if (!m[campo]) fallos.push(`module.json: falta ${campo}`);

const todos = (dir, ext, out = []) => {
  for (const f of readdirSync(join(raiz, dir))) {
    const ruta = join(dir, f);
    if (statSync(join(raiz, ruta)).isDirectory()) todos(ruta, ext, out);
    else if (ext.some((e) => f.endsWith(e))) out.push(ruta);
  }
  return out;
};

// Idiomas: mismas claves en es y en, y todas las claves usadas existen.
const es = JSON.parse(leer("lang/es.json"));
const en = JSON.parse(leer("lang/en.json"));
for (const k of Object.keys(es)) if (!(k in en)) fallos.push(`lang/en.json: falta ${k}`);
for (const k of Object.keys(en)) if (!(k in es)) fallos.push(`lang/es.json: falta ${k}`);
const usadas = new Set();
for (const f of [...todos("scripts", [".js", ".mjs"]), ...todos("templates", [".hbs"])]) {
  for (const x of leer(f).matchAll(/OLATTACK(?:\.[A-Za-z0-9_-]+)+/g)) usadas.add(x[0]);
}
// Prefijos de claves dinámicas (se construyen en tiempo de ejecución).
const dinamicas = ["OLATTACK.Counter", "OLATTACK.Preview", "OLATTACK.Scene.Death", "OLATTACK.Scene.Img"];
for (const k of usadas) {
  if (dinamicas.includes(k)) continue;
  if (!(k in es)) fallos.push(`Clave de idioma sin definir: ${k}`);
}

// Nada de la API V1 (retirada en Foundry 16) ni de evaluación de código dinámico.
for (const f of todos("scripts", [".js"])) {
  if (f.endsWith("check.mjs")) continue;
  const t = leer(f);
  if (/LegacyApplication|LegacyDialog|LegacyFormApplication|getActorSheetHeaderButtons|"renderChatMessage"/.test(t)) fallos.push(`${f}: usa API V1`);
  if (/[^.\w]Function\(|\beval\(/.test(t)) fallos.push(`${f}: evalúa código dinámico`);
}

if (fallos.length) {
  console.error(fallos.map((f) => `✗ ${f}`).join("\n"));
  process.exit(1);
}
console.log(`✓ OL Attack ${m.version}: manifiesto, idiomas (${Object.keys(es).length} claves) y código correctos`);
