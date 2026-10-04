import { FLAG_PREFS } from "../shared/constants.js";
import { leerFlag, escribirFlag } from "./flags.js";

export const loadActorPrefs = (actor) => leerFlag(actor, FLAG_PREFS) || {};

export async function migrateUserPrefsToActorIfNeeded(actor) {
  const actorPrefs = loadActorPrefs(actor);
  if (actorPrefs && Object.keys(actorPrefs).length) return actorPrefs;

  const userRoot = leerFlag(game.user, FLAG_PREFS) || null;
  const legacy = userRoot?.[actor.uuid];
  if (!legacy) return actorPrefs;

  const converted = {};
  const byItem = legacy.byItem || legacy?.prefs?.byItem || {};
  for (const [id, cfg] of Object.entries(byItem)) converted[id] = cfg;
  converted.lastUsedItemId = legacy.lastUsedItemId || legacy?.prefs?.lastUsedItemId || null;

  await escribirFlag(actor, FLAG_PREFS, converted);
  return converted;
}

export async function saveActorPrefs(actor, itemId, config, allPrefsRef) {
  const current = allPrefsRef || loadActorPrefs(actor);
  current[itemId] = config;
  current.lastUsedItemId = itemId;
  await escribirFlag(actor, FLAG_PREFS, current);
  return current;
}
