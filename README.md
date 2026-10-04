# OL Attack UI (Foundry v13 + D&D5e)

Este módulo convierte la macro "ATAQUE" en un módulo modular y ampliable.

## Uso rápido
1) Activa el módulo.
2) El módulo instala macros en la barra rápida: **1** abre OL Attack y **2** abre el monitor de combate.
3) Abre un actor o selecciona un token.
4) Pulsa el botón **OL Attack** en la cabecera de la hoja del actor, o ejecuta una macro:
```js
game.olAttack.open();
```

## Instalación
Manifest para Foundry:

```text
https://github.com/ManuRomera/ol-attack/releases/latest/download/module.json
```

## Notas
- Las preferencias se guardan en *flags del Actor* bajo `flags.ol-attack` (visibilidad, offhand, autoclose, prefs por ítem).
- La posición, tamaño y secciones plegadas de cada ventana se guardan por usuario y mundo en el navegador (localStorage).
- Todas las ventanas llevan un icono de accesibilidad junto al de cerrar (tamaño de texto, contraste, fuente legible, sin movimiento, ayuda inmediata).
- Enter (con el foco en la ventana) tira; Mayús+Enter ventaja; Alt+Enter desventaja. Flechas ↑↓ recorren la lista.
- Compatible con Foundry 13 (verificado 13.351) y dnd5e 5.3. Auditoría completa en `docs/AUDITORIA.md`.
- Las TS jugador-a-jugador usan socket `module.ol-attack`:
  - Jugador tira solo para sus actores (dueño).
  - GM tira por defecto solo PNJ (si hay PJ, cada jugador tira la suya).
  - Botón **GM: Tirar por todos** en la tarjeta para forzar con un clic.
  - Aviso (notificación) a los jugadores propietarios cuando hay TS pendientes.
- Los rasgos con `uses.max` en fórmula (p.ej. Inspiración Bárdica) se muestran y consumen correctamente.

## Estructura
- `scripts/` código modular
- `templates/` Handlebars
- `styles/` CSS
- `lang/` traducciones
