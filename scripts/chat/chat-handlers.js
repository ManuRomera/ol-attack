import { SOCKET_NS } from "../shared/constants.js";
import { alRenderizarMensaje, jq } from "../shared/compat.js";
import { olDialog } from "../ui/dialogs.js";
import { datosTarjeta, guardarTarjeta } from "../lib/flags.js";
import { gp, escapeHtml, safeNum, translateAbility, enrichDescription } from "../lib/utils.js";
import { applyDamageToActor, applyHealingToActor, getDamagePreview } from "../lib/damage.js";
import { adjustPendingDamageForSave, markPendingDamageApplied } from "../lib/damage-ledger.js";
import { renderSavesHtml } from "../lib/saves.js";
import { runAction, getChoiceModeRollParts } from "../workflow/execute.js";
import { getItemUses, consumeItemUse } from "../lib/uses.js";
import { shouldConsumeItemUseForProfile, shouldConsumeSpellSlotForProfile, shouldAutoApplyDamageOnFailedSave, shouldAutoApplyStatusOnFailedSave, getFailedSaveStatusId } from "../lib/action-profiles.js";
import { consumeSpellSlot } from "../lib/spells.js";
import { setStatusOnSubject } from "../lib/statuses.js";

const tr = (key, data) => game.i18n.format(key, data ?? {});

function getMsgData(message) {
  return datosTarjeta(message);
}

async function resolveTargetsFromMessage(message, data) {
  const hasExplicitTargets = Array.isArray(data.targets);
  const strictTargets = !!data.strictTargets;
  let targetUuids = hasExplicitTargets ? data.targets.filter(Boolean) : [];
  if (!targetUuids.length && !strictTargets) targetUuids = Array.from(game.user?.targets ?? []).map((t) => t.document.uuid);
  if (!targetUuids.length && !strictTargets && game.user.isGM) targetUuids = (canvas.tokens?.controlled || []).map((t) => t.document.uuid);

  // Fallback: si no hay targets, aplicamos al actor "speaker" (útil para conjuros a sí mismo).
  if (!targetUuids.length && !strictTargets) {
    const spkActorId = message?.speaker?.actor;
    const spkActor = spkActorId ? game.actors?.get?.(spkActorId) : null;
    if (spkActor) targetUuids = [spkActor.uuid];
  }

  const resolved = [];
  for (const uuid of targetUuids) {
    const tokDoc = await fromUuid(uuid).catch(() => null);
    const tActor = tokDoc?.actor || (tokDoc?.documentName === "Actor" ? tokDoc : null);
    if (!tActor) continue;
    resolved.push({ uuid, tokDoc: tokDoc?.actor ? tokDoc : null, tActor, tName: tokDoc?.name || tActor?.name || "Objetivo" });
  }
  return resolved;
}

function toggleDetails(btn) {
  const card = btn.closest(".ol-chat") || btn.closest(".chat-card") || btn.closest(".message-content");
  if (!card) return;
  if (!card.querySelector(".ol-hidden-details")) return ui.notifications.warn(tr("OLATTACK.Chat.NoDetails"));
  const open = card.classList.toggle("ol-details-open");
  btn.innerHTML = `<i class="fa-solid ${open ? "fa-eye-slash" : "fa-list"}"></i> ${tr(open ? "OLATTACK.HideDetails" : "OLATTACK.ToggleDetails")}`;
}

async function applyDamage(btn, message, data) {
  if (btn.dataset.olLock === "1") return;
  btn.dataset.olLock = "1";
  try {
    const damages = JSON.parse(btn.dataset.damages || "[]");
    if (!damages.length) return ui.notifications.warn("No hay daño que aplicar.");

    const isHomebrew = data.systemMode === "homebrew";
    const attackTags = Array.isArray(data.attackTags) ? data.attackTags : [];

    const resolved = await resolveTargetsFromMessage(message, data);
    if (!resolved.length) return ui.notifications.warn("⚠️ No hay objetivos: targets (T) o tokens seleccionados (GM).");

    // Preview simple + selector si varios
    const previews = resolved.map((r) => {
      const lines = damages.map((dmg, index) => {
        const original = safeNum(dmg.amount, 0);
        const preview = getDamagePreview(r.tActor, original, dmg.type, { homebrew: isHomebrew, attackTags, disableDefense: index > 0 });
        return {
          type: dmg.type,
          original,
          applied: safeNum(preview.applied, 0),
          multiplier: safeNum(preview.multiplier, 1),
          label: preview.modifier || preview.label || null
        };
      });
      const totalOriginal = lines.reduce((a, l) => a + l.original, 0);
      const totalApplied = lines.reduce((a, l) => a + l.applied, 0);
      const hasMods = lines.some((l) => l.multiplier !== 1 || !!l.label);
      return { ...r, preview: { lines, totalOriginal, totalApplied, hasMods } };
    });

    const applyToOne = async (entry) => {
      let totalForActor = 0, actDetails = [];
      const originalAmount = damages.reduce((sum, dmg) => sum + safeNum(dmg.amount, 0), 0);
      for (const [index, dmg] of damages.entries()) {
        const res = await applyDamageToActor(entry.tActor, dmg.amount, dmg.type, { homebrew: isHomebrew, attackTags, disableDefense: index > 0 });
        totalForActor += res.applied;
        actDetails.push(`${safeNum(dmg.amount, 0)}→${res.applied} ${dmg.type}${res.modified ? ` (${escapeHtml(res.modifier || "")})` : ""}`);
      }
      await markPendingDamageApplied({
        actorUuid: entry.tActor?.uuid || null,
        tokenUuid: entry.tokDoc?.uuid || entry.uuid || null,
        originalAmount,
        appliedTotal: totalForActor,
        source: "chat"
      });
      return { totalForActor, actDetails };
    };

    if (previews.length === 1 && (!previews[0].preview.hasMods)) {
      const r = previews[0];
      if (!game.user.isGM && !r.tActor.isOwner) return ui.notifications.warn("⚠️ No tienes permiso para aplicar daño a ese objetivo.");
      const out = await applyToOne(r);
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-check"></i> Daño aplicado`;
      ui.notifications.info(`<strong>Daño aplicado:</strong><br><strong>${escapeHtml(r.tName)}:</strong> Total ${out.totalForActor} [${out.actDetails.join(" | ")}]`);
      return;
    }

    const content = `
      <div class="ol-prev">
        <p class="ol-nota">${isHomebrew ? tr("OLATTACK.Chat.RulesHomebrew") : tr("OLATTACK.Chat.RulesNormal")}</p>
        ${previews.map((p) => `
          <label class="ol-prev-target">
            <input type="checkbox" class="ol-pre-check" data-uuid="${escapeHtml(p.uuid)}" checked>
            <img src="${escapeHtml(p.tActor.img)}" alt="">
            <span class="ol-prev-body">
              <span class="ol-prev-name">${escapeHtml(p.tName)}</span>
              <span class="ol-prev-total">${p.preview.totalOriginal} → <b>${p.preview.totalApplied}</b> ${p.preview.hasMods ? `<span class="ol-riv">RIV</span>` : ""}</span>
              <span class="ol-prev-lines">
                ${p.preview.lines.map((l) => `
                  <span class="ol-prev-line"><span>${escapeHtml(l.type)}</span><span><b>${l.original}</b> → <b>${l.applied}</b> ${l.multiplier !== 1 || l.label ? `<em>${escapeHtml(l.label || "")}</em>` : ""}</span></span>`).join("")}
              </span>
            </span>
          </label>`).join("")}
        <p class="ol-nota">${tr("OLATTACK.Chat.UncheckTargets")}</p>
      </div>`;

    const selected = await olDialog({
      title: "OLATTACK.Chat.PreviewDamage", icon: "fa-solid fa-burst", width: 560, content, memoria: "apply-damage",
      buttons: [
        {
          action: "apply", label: tr("OLATTACK.Chat.ApplySelected"), icon: "fa-solid fa-check", default: true,
          callback: (_ev, button) => Array.from(button.form.querySelectorAll("input.ol-pre-check:checked")).map((el) => el.dataset.uuid)
        },
        { action: "cancel", label: tr("OLATTACK.Cancel"), icon: "fa-solid fa-xmark", callback: () => null }
      ]
    });
    if (!selected) return;
    if (!selected.length) return ui.notifications.warn(tr("OLATTACK.Chat.NoTargetsPicked"));

    let appliedCount = 0, detailsMsg = "";
    for (const uuid of selected) {
      const entry = previews.find((x) => x.uuid === uuid);
      if (!entry || (!game.user.isGM && !entry.tActor.isOwner)) continue;
      const out = await applyToOne(entry);
      appliedCount++;
      detailsMsg += `<strong>${escapeHtml(entry.tName)}:</strong> Total ${out.totalForActor} [${out.actDetails.join(" | ")}]<br>`;
    }
    if (appliedCount) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-check"></i> ${tr("OLATTACK.Chat.DamageApplied")}`;
      ui.notifications.info(`<strong>${tr("OLATTACK.Chat.DamageApplied")}:</strong><br>${detailsMsg}`);
    }
  } finally {
    setTimeout(() => (btn.dataset.olLock = "0"), 200);
  }
}

async function applyHeal(btn, message, data) {
  if (btn.dataset.olLock === "1") return;
  btn.dataset.olLock = "1";
  try {
    const heals = JSON.parse(btn.dataset.heals || "[]");
    if (!heals.length) return ui.notifications.warn("No hay curación que aplicar.");

    const resolved = await resolveTargetsFromMessage(message, data);
    if (!resolved.length) return ui.notifications.warn("⚠️ No hay objetivos para curar.");

    const totalHeal = heals.reduce((a, h) => a + safeNum(h.amount, 0), 0);

    // Aplicar por parte (permite curación + temphp + tempmax, etc.)
    const applyToOne = async (entry) => {
      let out = { applied: 0, details: [] };
      for (const h of heals) {
        const amt = safeNum(h.amount, 0);
        if (!amt) continue;
        const tRaw = String(h.type || "healing");
        const t = tRaw.toLowerCase();
        const res = await applyHealingToActor(entry.tActor, amt, tRaw, { applyCurrent: !!h.applyCurrent });
        out.applied += safeNum(res?.applied, 0);
        if (t === "temphp") out.details.push(`PG temp: ${amt}`);
        else if (t === "temphpadd") out.details.push(`PG temp: +${amt}`);
        else if (t === "tempmax") out.details.push(`PG máx temp: +${amt}${h.applyCurrent ? " (y +PG actuales)" : ""}`);
        else out.details.push(`Curación: +${amt}`);
      }
      return out;
    };

    if (resolved.length === 1) {
      const r = resolved[0];
      if (!game.user.isGM && !r.tActor.isOwner) return ui.notifications.warn("⚠️ No tienes permiso.");
      const out = await applyToOne(r);
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-check"></i> Curación aplicada`;
      ui.notifications.info(`<strong>Aplicado:</strong><br><strong>${escapeHtml(r.tName)}:</strong> ${escapeHtml(out.details.join(" · ") || `+${totalHeal}`)}`);
      return;
    }

    const content = `
      <div class="ol-prev">
        <p class="ol-nota">${tr("OLATTACK.Chat.HealIntro", { total: totalHeal })}</p>
        ${resolved.map((r) => `
          <label class="ol-prev-target ol-prev-simple">
            <input type="checkbox" class="ol-heal-pick" data-uuid="${escapeHtml(r.uuid)}" checked>
            <span class="ol-prev-name">${escapeHtml(r.tName)}</span>
          </label>`).join("")}
      </div>`;

    const picks = await olDialog({
      title: "OLATTACK.Chat.ApplyHealTitle", icon: "fa-solid fa-heart-pulse", width: 420, content, memoria: "apply-heal",
      buttons: [
        {
          action: "apply", label: tr("OLATTACK.Chat.Apply"), icon: "fa-solid fa-check", default: true,
          callback: (_ev, button) => Array.from(button.form.querySelectorAll("input.ol-heal-pick:checked")).map((el) => el.dataset.uuid)
        },
        { action: "cancel", label: tr("OLATTACK.Cancel"), icon: "fa-solid fa-xmark", callback: () => null }
      ]
    });
    if (!picks?.length) return;

    let appliedCount = 0, detailsMsg = "";
    for (const uuid of picks) {
      const entry = resolved.find((x) => x.uuid === uuid);
      if (!entry || (!game.user.isGM && !entry.tActor.isOwner)) continue;
      const out = await applyToOne(entry);
      appliedCount++;
      detailsMsg += `<strong>${escapeHtml(entry.tName)}:</strong> ${escapeHtml(out.details.join(" · ") || `+${totalHeal}`)}<br>`;
    }
    if (appliedCount) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-check"></i> ${tr("OLATTACK.Chat.HealApplied")}`;
      ui.notifications.info(`<strong>${tr("OLATTACK.Chat.HealApplied")}:</strong><br>${detailsMsg}`);
    }
  } finally {
    setTimeout(() => (btn.dataset.olLock = "0"), 200);
  }
}

async function applyFailedSaveConsequences({ message, data, target } = {}) {
  const notices = [];
  let damageApplied = false;
  const profile = data?.actionProfile || null;

  if (profile && shouldAutoApplyDamageOnFailedSave(profile)) {
    const damages = Array.isArray(data?.damagePayload) ? data.damagePayload : [];
    if (damages.length) {
      const isHomebrew = data?.systemMode === "homebrew";
      const attackTags = Array.isArray(data?.attackTags) ? data.attackTags : [];
      let totalApplied = 0;
      const details = [];
      for (const [index, dmg] of damages.entries()) {
        try {
          const res = await applyDamageToActor(target.actor, dmg.amount, dmg.type, { homebrew: isHomebrew, attackTags, disableDefense: index > 0 });
          const applied = safeNum(res?.applied, 0);
          totalApplied += applied;
          details.push(`${safeNum(dmg.amount, 0)}→${applied} ${dmg.type}`);
        } catch (err) {
          console.warn('[ol-attack] No se pudo aplicar daño automático tras fallar la TS', err);
        }
      }
      if (details.length) {
        damageApplied = true;
        await markPendingDamageApplied({
          actorUuid: target.actor?.uuid || null,
          tokenUuid: target.tokenDoc?.uuid || target.tokenUuid || null,
          originalAmount: damages.reduce((sum, dmg) => sum + safeNum(dmg.amount, 0), 0),
          appliedTotal: totalApplied,
          source: "chat"
        });
        notices.push(`Daño automático: ${totalApplied} (${details.join(' · ')})`);
      }
    }
  }

  if (profile && shouldAutoApplyStatusOnFailedSave(profile)) {
    const statusId = getFailedSaveStatusId(profile);
    if (statusId) {
      const res = await setStatusOnSubject({ actor: target.actor, token: target.tokenDoc, statusId, active: true });
      if (res?.ok) notices.push(`Estado aplicado: ${res.label}`);
      else notices.push(`Estado no aplicado: ${statusId}`);
    }
  }

  return { notices, damageApplied };
}

async function handleSaveRoll(btn, message, data, ev) {
  ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();

  if (btn.dataset.olLock === "1") return;
  btn.dataset.olLock = "1";
  try {
    const saveKey = String(btn.dataset.savekey || "").trim();
    const abil = String(btn.dataset.ability || "").trim();
    const dcRaw = String(btn.dataset.dc || "").trim();
    const dcText = String(btn.dataset.dctext || "").trim();
    const timing = String(btn.dataset.timing || "pre").trim();
    const gmMode = String(btn.dataset.gmmode || "").trim();

    const dcVal = Number.isFinite(Number(dcRaw)) ? Number(dcRaw) : NaN;
    const dcLabel = Number.isFinite(dcVal) ? String(dcVal) : (dcText || "—");

    const targetsMeta = Array.isArray(data.targetsMeta) ? data.targetsMeta : [];
    const targetActors = [];
    for (const t of targetsMeta) {
      const aUuid = t.actorUuid;
      if (!aUuid) continue;
      const a = await fromUuid(aUuid).catch(() => null);
      if (!a) continue;
      const tokenDoc = t.tokenUuid ? await fromUuid(t.tokenUuid).catch(() => null) : null;
      targetActors.push({ actor: a, actorUuid: aUuid, tokenUuid: t.tokenUuid || null, tokenDoc, name: t.name || a.name || "Objetivo" });
    }
    if (!targetActors.length) return ui.notifications.warn("⚠️ No hay objetivos resolubles para esta TS.");

    const isGM = game.user.isGM;
    const forceAll = isGM && (ev.shiftKey || gmMode === "all");
    const allowRepeat = !!ev.shiftKey; // Shift+click siempre permite repetir

    let toRoll = [];
    if (forceAll) {
      // GM: tirar por todos (incluye PCs y PNJs)
      toRoll = targetActors;
    } else if (isGM) {
      // GM por defecto: solo PNJs (si hay PCs, que tiren sus dueños)
      toRoll = targetActors.filter((t) => !t.actor?.hasPlayerOwner);
      if (!toRoll.length) {
        return ui.notifications.info(game.i18n?.localize?.("OLATTACK.WaitingPlayers") || "🧑‍🤝‍🧑 Esperando a que cada jugador tire su salvación (usa el botón GM para tirar por todos). ");
      }
    } else {
      // Jugador: solo sus actores
      toRoll = targetActors.filter((t) => t.actor?.isOwner);
      if (!toRoll.length) return ui.notifications.warn("⚠️ Esta TS debe tirarla el jugador dueño del personaje objetivo.");
    }

    const saveTrack = data.saveTrack || {};
    const done = saveTrack?.[saveKey] || {};
    const pending = toRoll.filter((t) => allowRepeat || !done[t.actorUuid]);
    if (!pending.length) return ui.notifications.info("✅ Ya está registrada tu tirada para esta TS. (Shift+click para repetir)");

    let chosen = pending;
    // Solo los jugadores reciben selector (GM: un clic = tirar todo lo pendiente)
    if (!isGM && pending.length > 1 && !ev.shiftKey) {
      const content = `
        <div class="ol-prev">
          <p class="ol-nota">${tr("OLATTACK.Chat.PickSaveTargets")}</p>
          ${pending.map((tg) => `
            <label class="ol-prev-target ol-prev-simple">
              <input type="checkbox" class="ol-save-pick" data-uuid="${escapeHtml(tg.actorUuid)}" checked>
              <span class="ol-prev-name">${escapeHtml(tg.name)}</span>
            </label>`).join("")}
        </div>`;
      const selectedUuids = await olDialog({
        title: "OLATTACK.SaveRoll", icon: "fa-solid fa-shield-halved", width: 420, content, memoria: "save-pick",
        buttons: [
          {
            action: "ok", label: tr("OLATTACK.Chat.Roll"), icon: "fa-solid fa-dice-d20", default: true,
            callback: (_ev, button) => Array.from(button.form.querySelectorAll("input.ol-save-pick:checked")).map((el) => el.dataset.uuid)
          },
          { action: "cancel", label: tr("OLATTACK.Cancel"), icon: "fa-solid fa-xmark", callback: () => [] }
        ]
      }) ?? [];
      chosen = pending.filter((tg) => selectedUuids.includes(tg.actorUuid));
      if (!chosen.length) return ui.notifications.warn(tr("OLATTACK.Chat.NoTargetsPicked"));
    }

    // Tirar
    const rollSaveForActor = async (a, ability) => {
      const abilKey = String(ability || "").toLowerCase();
      let bonus = Number(gp(a, `system.abilities.${abilKey}.save`));
      if (!Number.isFinite(bonus)) bonus = Number(gp(a, `system.abilities.${abilKey}.mod`)) || 0;
      const bonusPart = bonus < 0 ? `(${bonus})` : `${bonus}`;
      const roll = new Roll(`1d20 + ${bonusPart}`);
      await roll.evaluate();
      try { if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true); } catch {}
      return roll;
    };

    let rowsHtml = "";
    const autoAppliedActorUuids = new Set();
    const autoAppliedTokenUuids = new Set();
    for (const t of chosen) {
      const roll = await rollSaveForActor(t.actor, abil);
      const total = roll?.total;
      const hasDC = Number.isFinite(dcVal);
      const success = hasDC ? safeNum(total, 0) >= dcVal : null;

      game.socket?.emit?.(SOCKET_NS, { type: "saveDone", originMessageId: message.id, saveKey, actorUuid: t.actorUuid, userId: game.user.id, total: total ?? null, success });

      const saveSuccessDamageMode = String(data?.saveSuccessDamageMode || "none");
      if (success !== null && saveSuccessDamageMode === "half") {
        await adjustPendingDamageForSave({
          messageId: message.id,
          actorUuid: t.actorUuid,
          tokenUuid: t.tokenUuid,
          scale: success ? 0.5 : 1,
          reason: success ? "Salvación superada: medio daño" : "Salvación fallida: daño completo"
        });
      }

      const autoResult = success === false ? await applyFailedSaveConsequences({ message, data, target: t }) : { notices: [], damageApplied: false };
      if (autoResult?.damageApplied) {
        autoAppliedActorUuids.add(t.actorUuid);
        if (t.tokenUuid) autoAppliedTokenUuids.add(t.tokenUuid);
      }

      const state = success === null ? "none" : success ? "success" : "fail";
      const badgeText = success === null ? "—" : success ? tr("OLATTACK.Chat.Success") : tr("OLATTACK.Chat.Failure");
      const noticesHtml = Array.isArray(autoResult?.notices) && autoResult.notices.length
        ? `<div class="ol-save-notices">${autoResult.notices.map((note) => `<div><i class="fa-solid fa-gear"></i> ${escapeHtml(note)}</div>`).join("")}</div>`
        : "";

      rowsHtml += `
        <div class="ol-save-row is-${state}">
          <div class="ol-save-who">
            <b data-tooltip="${escapeHtml(t.name)}">${escapeHtml(t.name)}</b>
            <small>${escapeHtml(game.user.name)} · <code>${escapeHtml(roll.formula)}</code></small>
          </div>
          <div class="ol-save-total">${total ?? "—"}</div>
          <div class="ol-save-badge">${badgeText}</div>
          ${noticesHtml}
        </div>`;
    }

    if (autoAppliedActorUuids.size) {
      const liveData = getMsgData(message);
      const remainingTargetsMeta = (Array.isArray(liveData.targetsMeta) ? liveData.targetsMeta : []).filter((t) => {
        const actorHit = t?.actorUuid && autoAppliedActorUuids.has(t.actorUuid);
        const tokenHit = t?.tokenUuid && autoAppliedTokenUuids.has(t.tokenUuid);
        return !(actorHit || tokenHit);
      });
      const removedUuids = new Set((Array.isArray(liveData.targetsMeta) ? liveData.targetsMeta : [])
        .filter((t) => (t?.actorUuid && autoAppliedActorUuids.has(t.actorUuid)) || (t?.tokenUuid && autoAppliedTokenUuids.has(t.tokenUuid)))
        .flatMap((t) => [t?.tokenUuid, t?.actorUuid])
        .filter(Boolean));
      const remainingTargets = (Array.isArray(liveData.targets) ? liveData.targets : []).filter((uuid) => !removedUuids.has(uuid));
      await guardarTarjeta(message, {
        ...liveData,
        targets: remainingTargets,
        targetsMeta: remainingTargetsMeta,
        strictTargets: true
      });
    }

    const timingText = tr(timing === "post" ? "OLATTACK.Chat.TimingAfter" : "OLATTACK.Chat.TimingBefore");
    const abilityLabel = translateAbility(abil);

    const saveCardHtml = `
      <div class="ol-chat ol-chat-save" data-kind="save">
        <header class="ol-chat-head">
          <i class="ol-chat-icon fa-solid fa-shield-halved"></i>
          <div class="ol-chat-title"><h3>${tr("OLATTACK.SaveRoll")}</h3><div class="ol-chat-sub">${escapeHtml(data.itemName || tr("OLATTACK.Chat.Effect"))}</div></div>
        </header>
        <div class="ol-chat-tags ol-chat-tags-bar">
          <span class="ol-tag"><i class="fa-solid fa-shield-halved"></i> ${escapeHtml(abilityLabel)} ${tr("OLATTACK.Chat.DC")} ${escapeHtml(dcLabel)}</span>
          <span class="ol-tag"><i class="fa-solid fa-clock"></i> ${tr("OLATTACK.Chat.ResolvesTiming", { timing: timingText })}</span>
        </div>
        <div class="ol-chat-body">${rowsHtml}</div>
      </div>`;

    await ChatMessage.create({ speaker: message.speaker || ChatMessage.getSpeaker(), content: saveCardHtml });
  } finally {
    setTimeout(() => (btn.dataset.olLock = "0"), 200);
  }
}



async function handleChoiceMode(btn, message, data) {
  const choice = String(btn.dataset.choice || "").toLowerCase();
  if (!["heal", "damage"].includes(choice)) return;
  const liveData = getMsgData(message);
  if (liveData?.specialResolved) return ui.notifications.warn("⚠️ Esta acción ya ha sido resuelta.");

  const actor = data.actorUuid ? await fromUuid(data.actorUuid).catch(() => null) : null;
  if (!actor) return ui.notifications.warn("⚠️ No se encuentra el actor original de la acción.");

  const tokenDoc = data.tokenUuid ? await fromUuid(data.tokenUuid).catch(() => null) : null;
  const token = tokenDoc?.object || tokenDoc || null;
  const item = actor.items.get(data.itemId) || (data.itemUuid ? await fromUuid(data.itemUuid).catch(() => null) : null);
  if (!item) return ui.notifications.warn("⚠️ No se encuentra el ítem de la acción.");

  const actionProfile = liveData?.actionProfile || data?.actionProfile || null;
  const consumeUsesDecision = actionProfile ? shouldConsumeItemUseForProfile(actionProfile, choice) : undefined;
  const consumeSlotDecision = actionProfile ? shouldConsumeSpellSlotForProfile(actionProfile, choice) : undefined;
  const u = getItemUses(item);
  if (consumeUsesDecision !== false && u.max > 0) {
    const res = await consumeItemUse(item, 1);
    if (!res.ok) return ui.notifications.warn(`⚠️ Sin usos restantes para ${item.name}.`);
  }
  const spellLevel = safeNum(data?.spellLevel, 0);
  const slotKey = data?.slotKey || null;
  const consumeSlot = !!data?.consumeSlot;
  if (consumeSlot && spellLevel > 0 && slotKey && consumeSlotDecision !== false) {
    const res = await consumeSpellSlot(actor, slotKey);
    if (!res?.ok) ui.notifications.warn("⚠️ No te quedaban espacios para gastar (pero la acción se resolvió).");
  }

  const targetDocs = [];
  for (const uuid of Array.isArray(data.targets) ? data.targets : []) {
    const doc = await fromUuid(uuid).catch(() => null);
    const targetActor = doc?.actor || (doc?.documentName === "Actor" ? doc : null);
    if (!targetActor) continue;
    targetDocs.push({ document: doc, actor: targetActor, name: doc?.name || targetActor?.name || "Objetivo" });
  }

  const parts = getChoiceModeRollParts({ actor, item, mode: choice, targets: targetDocs, profile: actionProfile, spellLevel });
  await runAction({
    actor,
    token,
    item,
    opts: {
      mode: "normal",
      systemMode: "normal",
      ability: "auto",
      dmgMode: "auto",
      prof: false,
      temp: 0,
      isOffhand: false,
      offhandFormula: "1d6",
      offhandDamageType: "bludgeoning",
      itemImg: item.img || "icons/svg/mystery-man.svg",
      itemName: item.name,
      rollTitle: `${item.name} — ${choice === "heal" ? "Curar" : "Dañar"}`,
      descriptionHtml: await enrichDescription(item, actor),
      showDescription: true,
      showSaves: choice === "damage",
      spellLevel,
      castLevelUp: item?.type === "spell" && spellLevel > safeNum(item?.system?.level, 0),
      applyRage: false,
      applyReckless: false,
      applyFrenzy: false,
      applySneak: false,
      applySavage: false,
      applyWails: false,
      applyHex: false,
      applyExtraDice: false,
      extraDiceFormula: "",
      extraDiceLabel: "",
      effectExtraDiceFormula: "",
      effectExtraDiceLabel: "",
      rageBonus: 0,
      sneakFormula: "",
      targetUuids: Array.isArray(data.targets) ? data.targets : [],
      forceCardKind: choice === "heal" ? "heal" : "damage",
      overrideRollParts: parts,
      choiceMode: choice,
      resolvedActionProfile: actionProfile
    }
  });

  await guardarTarjeta(message, { ...liveData, specialResolved: choice });
  btn.closest('.card-buttons')?.querySelectorAll('button.ol-divine-spark-choice')?.forEach((b) => { b.disabled = true; });
}

export function registerChatHandlers() {
  alRenderizarMensaje((message, el) => {
    const data = getMsgData(message);
    if (!data || !Object.keys(data).length) return;
    const html = jq(el);

    // Marcar chat como GM para mostrar controles GM-only via CSS
    if (game.user.isGM) el.classList.add("ol-chat-is-gm");

    if (data.specialResolved) {
      html.find("button.ol-divine-spark-choice").prop("disabled", true);
    }

    html.find("button.ol-toggle-details").off("click").on("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); toggleDetails(ev.currentTarget); });
    html.find("button.ol-apply-damage").off("click").on("click", async (ev) => applyDamage(ev.currentTarget, message, data));
    html.find("button.ol-apply-heal").off("click").on("click", async (ev) => applyHeal(ev.currentTarget, message, data));
    html.find("button.ol-roll-save").off("click").on("click", async (ev) => handleSaveRoll(ev.currentTarget, message, data, ev));
    html.find("button.ol-roll-save-gm").off("click").on("click", async (ev) => handleSaveRoll(ev.currentTarget, message, data, ev));
    html.find("button.ol-divine-spark-choice").off("click").on("click", async (ev) => handleChoiceMode(ev.currentTarget, message, data));
  });
}

// helper usado por socket: re-render saves block in message
export async function updateSavesBlock(message) {
  const data = getMsgData(message);
  const saveDefs = Array.isArray(data.saveDefs) ? data.saveDefs : [];
  const targetsMeta = Array.isArray(data.targetsMeta) ? data.targetsMeta : [];
  const saveTrack = data.saveTrack || {};
  if (!saveDefs.length) return;

  const newHtml = renderSavesHtml({ saveDefs, targetsMeta, saveTrack });

  const content = message.content || "";
  const updated = content.includes("<!--OL-SAVES-START-->")
    ? content.replace(/<!--OL-SAVES-START-->[\s\S]*?<!--OL-SAVES-END-->/, newHtml)
    : (content + newHtml);

  await message.update({ content: updated });
}
