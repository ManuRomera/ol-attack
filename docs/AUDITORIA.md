# Auditoría de OL Attack (0.1.86 → 0.2.0)

Fecha: 2026-10-04 · Foundry 13.351 · dnd5e 5.3.0. Verificado en un Foundry real (mundo de prueba aislado).

## Resumen

El módulo funcionaba en lo esencial (tiradas, daño, salvaciones, monitor), pero estaba construido sobre
Application V1 (retirada en Foundry 16), tenía **dos puntos de entrada rotos en v13**, un **fallo de seguridad**,
repintados que escribían en la base de datos del mundo a cada movimiento de token y una interfaz que obligaba a
desplazarse para llegar al botón de tirar. La 0.2.0 corrige todo lo de abajo.

## Fallos y bugs (corregidos en 0.2.0)

| # | Gravedad | Hallazgo | Corrección |
|---|---|---|---|
| 1 | Crítica | El botón «OL Attack» **no aparecía en las fichas de dnd5e 5.x** (usaba `getActorSheetHeaderButtons`, solo V1). | Icono inyectado en la cabecera de cualquier hoja de Actor ApplicationV2 (`ui/sheet-buttons.js`). |
| 2 | Crítica | El botón del **HUD del token** usaba `html.find` sobre un HTMLElement (v13) → error al abrir el HUD. | Botón creado con DOM nativo. |
| 3 | Seguridad | `lib/uses.js` evaluaba `system.uses.max` con `Function(...)`; lo edita cualquier jugador dueño del objeto y el monitor del GM lo calculaba para todos los tokens → ejecución de JS en el cliente del GM. El filtro era evitable con escapes. | Se evalúa como `Roll` determinista, sin código y rechazando dados. `scripts/check.mjs` impide reintroducir `Function(`/`eval(`. |
| 4 | Alta | El **Enter** lanzaba un ataque desde cualquier parte de Foundry (listener global en `document`) y se acumulaba un listener por repintado. | Listener solo dentro de la ventana; flechas ↑↓ y Espacio para navegar la lista. |
| 5 | Alta | Cada movimiento de token, cambio de PG o repintado del monitor del GM **escribía el ajuste de mundo** `playerScenePublicState` y emitía por socket, sin límite. | Repintado con *debounce*, filtros de relevancia (mover un token o un cambio de flags no repinta) y publicación solo si el contenido cambió. |
| 6 | Alta | Alcance de «Lamentos desde la tumba» con `canvas.grid.measureDistance` (eliminada en v13): la lista de segundos objetivos salía siempre vacía. | `canvas.grid.measurePath` vía `shared/compat.js`. |
| 7 | Media | Las macros del módulo **pisaban en cada inicio de sesión** los huecos 1 y 2 de la barra rápida y reescribían su código. | Solo se crean si faltan y solo ocupan huecos libres; ajuste para desactivarlo. |
| 8 | Media | `open()` apilaba ventanas con el mismo `id`. | Ventana única reutilizada para otro personaje. |
| 9 | Media | Estados con `TokenDocument#toggleActiveEffect` (obsoleto) y pasando un objeto en vez del id. | `Actor#toggleStatusEffect(id)`. |
| 10 | Media | `TextEditor.enrichHTML` global y `renderChatMessage` (obsoletos en v13, retirados en v15). | `foundry.applications.ux.TextEditor.implementation` y `renderChatMessageHTML`. |
| 11 | Media | Código muerto: `_buildConfigHtml` (~190 líneas), `openActorStatusQuickMenu`, `window-layout.js`, `windowState`. | Eliminado. |
| 12 | Baja | `window.confirm` nativo para vaciar el libro de daño. | Diálogo del módulo. |
| 13 | Baja | Estado de ventana (posición/tamaño) guardado en ajustes a cada arrastre, por duplicado (`window-layout` + estado propio). | `localStorage` por usuario y mundo (`lib/memoria.js`). |
| 14 | Baja | Flags bajo el ámbito genérico `world`. | `flags.ol-attack.*`; lectura con respaldo y migración única del GM (`lib/flags.js`). |

## Usabilidad y espacio (0.2.0)

- Botones **Normal / Ventaja / Desventaja siempre visibles** (barra inferior fija); antes quedaban fuera de la ventana de 720 px.
- PG, PG temporales, espacios, usos y concentración en **una sola franja** (≈150 px → ≈55 px).
- Lista agrupada y plegable (con memoria), ajustes de tirada plegables; diseño de una columna en ventanas estrechas.
- Monitores: tarjetas sin bloques vacíos («Sin estados», «Sin recursos»), cabecera en una línea, libro de daño plegable, rejilla adaptativa.
- Tarjetas de chat compactas (miniatura de 2,4 em en vez de imagen de 200 px), adaptadas a tema claro/oscuro, detalles plegables.
- Orientación del monitor de jugador: un botón en lugar de un diálogo con «Guardar».
- Ventana de configuración del monitor: 1060×700 (antes 1460×900, mayor que la mayoría de pantallas).

## Mejoras comunes a todos los sistemas, aplicadas

ApplicationV2 + DialogV2 · memoria de ventana · **icono de accesibilidad** junto al de cerrar (texto, contraste, fuente legible, sin movimiento, ayuda inmediata) · **encuadre de retrato** (`object-view-box`, flag `flags.ol-attack.retrato`, visible en ventanas, directorio de Actores y combate) · **iconos de cabecera intactos** (el CSS nunca toca `font-family` de elementos Font Awesome; comprobado en vivo: cerrar, accesibilidad y menú = «Font Awesome 6 Pro») · compat v13/v14 centralizada en `shared/compat.js` · idiomas es/en completos con comprobación automática · release por etiqueta con CI.

## Pendiente / decisiones para ti

1. **Textos internos del motor** (`damage.js`, `riv.js`, `tags.js`, `features.js`, perfiles de acción): aún en español fijo. La interfaz, avisos y tarjetas ya están en es/en.
2. **Perfiles de acción**: el catálogo pinta ~1000 filas en un mundo grande (sin virtualizar). Conviene paginar o filtrar por actor.
3. **Reglas de la mesa** codificadas por nombre (Aid, Toll the Dead, Rabia, Frenesí…): funcionan, pero son frágiles ante traducciones; mejor moverlas a perfiles JSON.
4. **Curación**: `applyHealingToActor` limita a `hp.max`; con PG máximos temporales debería usar el máximo efectivo.
5. **Chat**: `updateSavesBlock` reescribe todo el `content` del mensaje (necesita permisos de GM vía socket); mejor repintar solo el bloque.
6. Versión mínima de dnd5e: probado con 5.3.0; no se ha probado dnd5e 5.0/5.1.
7. Probar con **dos usuarios** (GM + jugador) el monitor resumido y las salvaciones por socket; aquí se verificó la vista de jugador instanciándola, no con una segunda sesión.
