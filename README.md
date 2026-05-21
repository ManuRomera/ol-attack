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
- Las preferencias se guardan en *flags del Actor* (visibilidad, offhand, autoclose, prefs por ítem).
- El estado de ventana (posición/tamaño/pestaña/último ítem) se guarda por usuario (setting client).
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
