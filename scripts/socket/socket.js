import { SOCKET_NS, FLAG_SCOPE, FLAG_KEY } from "../shared/constants.js";
import { updateSavesBlock } from "../chat/chat-handlers.js";
import { addPendingDamageLines, adjustPendingDamageForSave, markPendingDamageApplied } from "../lib/damage-ledger.js";

export function registerSocket() {
  if (game.olAttackSocketInit) return;
  game.olAttackSocketInit = true;

  game.socket?.on?.(SOCKET_NS, async (payload) => {
    try {
      if (!payload || typeof payload !== "object") return;
      // Avisos de TS (para jugadores)
      if (payload.type === "saveRequest") {
        const ids = Array.isArray(payload.userIds) ? payload.userIds : [];
        if (!ids.includes(game.user.id)) return;
        const nm = payload.itemName ? `: ${payload.itemName}` : "";
        ui.notifications?.info?.(game.i18n?.localize?.("OLATTACK.SaveRequest")
          ? `${game.i18n.localize("OLATTACK.SaveRequest")}${nm}`
          : `📣 Tirada de salvación pendiente${nm}`);
        return;
      }

      if (payload.type === "playerRollInitiative") {
        if (!game.user?.isGM) return;
        const tokenIds = Array.isArray(payload.tokenIds) ? payload.tokenIds.map((v) => String(v || '')).filter(Boolean) : [];
        const sceneId = String(payload.sceneId || canvas?.scene?.id || '');
        const userId = String(payload.userId || '');
        if (!tokenIds.length || !sceneId || !userId) return;
        const sceneCombat = game.combats?.find?.((c) => String(c.scene?.id || c.scene) === sceneId);
        if (!sceneCombat) return;
        const requester = game.users?.get?.(userId);
        if (!requester) return;
        const combatantIds = [];
        for (const tokenId of tokenIds) {
          const token = canvas?.scene?.id === sceneId ? (canvas?.tokens?.get?.(tokenId) || canvas?.tokens?.placeables?.find?.((t) => String(t.id) === tokenId)) : null;
          const actor = token?.actor || sceneCombat?.combatants?.find?.((c) => String(c.tokenId) === tokenId)?.actor || null;
          let canControl = false;
          try { canControl = !!actor?.testUserPermission?.(requester, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER); } catch (_) {}
          if (!canControl && actor) {
            try { canControl = !!actor?.testUserPermission?.(requester, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER); } catch (_) {}
          }
          if (!canControl) continue;
          const combatant = Array.from(sceneCombat.combatants || []).find((c) => String(c.tokenId) === tokenId);
          if (!combatant) continue;
          if (combatant.initiative !== null && combatant.initiative !== undefined) continue;
          combatantIds.push(combatant.id);
        }
        if (combatantIds.length) {
          await sceneCombat.rollInitiative(combatantIds);
        }
        return;
      }

      if (payload.type === "playerSceneState") {
        if (game.user?.isGM) return;
        game.olAttack?.receivePlayerSceneState?.(payload.state || {});
        return;
      }

      if (payload.type === "playerSceneClose") {
        if (game.user?.isGM) return;
        game.olAttack?.closePlayerSceneTracker?.();
        return;
      }

      if (payload.type === "damageLedgerAdd") {
        if (!game.user?.isGM) return;
        await addPendingDamageLines(payload.payload || {}, { remote: true });
        return;
      }

      if (payload.type === "damageLedgerApplied") {
        if (!game.user?.isGM) return;
        await markPendingDamageApplied(payload.payload || {}, { remote: true });
        return;
      }

      if (payload.type === "damageLedgerAdjustSave") {
        if (!game.user?.isGM) return;
        await adjustPendingDamageForSave(payload.payload || {}, { remote: true });
        return;
      }

      // Tracking de TS (solo GM)
      if (!game.user.isGM) return;
      if (payload.type !== "saveDone") return;

      const { originMessageId, saveKey, actorUuid, userId, total, success } = payload;
      if (!originMessageId || !saveKey || !actorUuid) return;

      const msg = game.messages.get(originMessageId);
      if (!msg) return;

      const data = msg.getFlag(FLAG_SCOPE, FLAG_KEY) || {};
      const saveTrack = data.saveTrack || {};
      saveTrack[saveKey] = saveTrack[saveKey] || {};
      saveTrack[saveKey][actorUuid] = { userId, total, success, ts: Date.now() };

      data.saveTrack = saveTrack;
      await msg.setFlag(FLAG_SCOPE, FLAG_KEY, data);

      await updateSavesBlock(msg);
    } catch (e) {
      console.warn("OL-ATTACK socket handler error", e);
    }
  });
}
