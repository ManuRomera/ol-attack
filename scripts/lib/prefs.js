import { FLAG_SCOPE, FLAG_PREFS } from "../shared/constants.js";

export const loadActorPrefs = (actor) => actor.getFlag(FLAG_SCOPE, FLAG_PREFS) || {};

export async function migrateUserPrefsToActorIfNeeded(actor) {
  const actorPrefs = loadActorPrefs(actor);
  if (actorPrefs && Object.keys(actorPrefs).length) return actorPrefs;

  const userRoot = game.user?.getFlag?.(FLAG_SCOPE, FLAG_PREFS) || null;
  const legacy = userRoot?.[actor.uuid];
  if (!legacy) return actorPrefs;

  const converted = {};
  const byItem = legacy.byItem || legacy?.prefs?.byItem || {};
  for (const [id, cfg] of Object.entries(byItem)) converted[id] = cfg;
  converted.lastUsedItemId = legacy.lastUsedItemId || legacy?.prefs?.lastUsedItemId || null;

  await actor.setFlag(FLAG_SCOPE, FLAG_PREFS, converted);
  return converted;
}

export async function saveActorPrefs(actor, itemId, config, allPrefsRef) {
  const current = allPrefsRef || loadActorPrefs(actor);
  current[itemId] = config;
  current.lastUsedItemId = itemId;
  await actor.setFlag(FLAG_SCOPE, FLAG_PREFS, current);
  return current;
}
