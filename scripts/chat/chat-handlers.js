import { FLAG_SCOPE, FLAG_KEY, SOCKET_NS } from "../shared/constants.js";
import { LegacyDialog } from "../shared/compat.js";
import { gp, escapeHtml, safeNum, translateAbility, enrichDescription } from "../lib/utils.js";
import { applyDamageToActor, applyHealingToActor, getDamagePreview } from "../lib/damage.js";
import { adjustPendingDamageForSave, markPendingDamageApplied } from "../lib/damage-ledger.js";
import { renderSavesHtml } from "../lib/saves.js";
import { runAction, getChoiceModeRollParts } from "../workflow/execute.js";
import { getItemUses, consumeItemUse } from "../lib/uses.js";
import { shouldConsumeItemUseForProfile, shouldConsumeSpellSlotForProfile, shouldAutoApplyDamageOnFailedSave, shouldAutoApplyStatusOnFailedSave, getFailedSaveStatusId } from "../lib/action-profiles.js";
import { consumeSpellSlot } from "../lib/spells.js";
import { setStatusOnSubject } from "../lib/statuses.js";

function getMsgData(message) {
  return message?.getFlag?.(FLAG_SCOPE, FLAG_KEY) || {};
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
  const root = btn.closest(".chat-card") || btn.closest(".message") || btn.closest(".chat-message");
  if (!root) return;
  const hiddenBlocks = root.querySelectorAll?.(".ol-hidden-details") ?? [];
  if (!hiddenBlocks.length) return ui.notifications.warn("⚠️ No hay detalles ocultos en este mensaje.");

  const anyVisible = Array.from(hiddenBlocks).some(h => {
    const disp = h.style?.display ?? "";
    return disp !== "none" && disp !== "";
  });

  const nextDisplay = anyVisible ? "none" : "block";
  hiddenBlocks.forEach(h => { h.style.display = nextDisplay; });

  btn.innerHTML = anyVisible ? game.i18n.localize("OLATTACK.ToggleDetails") : game.i18n.localize("OLATTACK.HideDetails");
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
      <div style="font-family:Roboto,sans-serif;">
        <div style="color:#bbb; font-size:12px; margin-bottom:8px;">
          ${isHomebrew ? "🛡️ Homebrew: defensa por CA y RIV 33%. Respeta bypasses." : "✨ Normal: RIV 33%. Respeta bypasses."}
        </div>
        <hr style="border:0;border-top:1px solid #333;margin:10px 0;">
        ${previews.map((p) => `
          <label style="display:flex; gap:10px; align-items:flex-start; padding:10px; border:1px solid #444; border-radius:10px; background:#1b1b1b; margin-bottom:10px;">
            <input type="checkbox" class="ol-pre-check" data-uuid="${p.uuid}" checked style="margin-top:6px;">
            <img src="${p.tActor.img}" onerror="this.src='icons/svg/mystery-man.svg'" style="width:34px;height:34px;border-radius:6px;object-fit:cover;border:1px solid #333;background:#000;margin-top:2px;">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:900;color:#eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.tName)}</div>
              <div style="font-size:11px;color:#aaa;margin-top:2px;">Total: ${p.preview.totalOriginal} → <b>${p.preview.totalApplied}</b> ${p.preview.hasMods ? `<span style="font-size:11px;font-weight:800;color:#111;background:#d29a38;border-radius:999px;padding:2px 8px;margin-left:8px;">RIV</span>` : ""}</div>
              <div style="margin-top:8px; font-size:12px; color:#ddd;">
                ${p.preview.lines.map((l) => `
                  <div style="display:flex; justify-content:space-between; gap:10px; padding:3px 0; border-bottom:1px dashed rgba(255,255,255,0.08);">
                    <span>${escapeHtml(l.type)}</span>
                    <span><b>${l.original}</b> → <b>${l.applied}</b> ${l.multiplier !== 1 || l.label ? `<span style="color:#d29a38;">${escapeHtml(l.label || "")}</span>` : ""}</span>
                  </div>`).join("")}
              </div>
            </div>
          </label>`).join("")}
        <div style="color:#bbb; font-size:12px;">Desmarca los objetivos a los que NO quieres aplicar daño.</div>
      </div>`;

    new LegacyDialog({
      title: "Previsualizar & Aplicar Daño",
      content,
      buttons: {
        apply: {
          label: "Aplicar a seleccionados",
          callback: async (html) => {
            const selected = [];
            html.find("input.ol-pre-check").each((_, el) => { if (el.checked) selected.push(el.dataset.uuid); });
            if (!selected.length) return ui.notifications.warn("⚠️ No has seleccionado objetivos.");

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
              btn.innerHTML = `<i class="fas fa-check"></i> Daño aplicado`;
              ui.notifications.info(`<strong>Daño aplicado:</strong><br>${detailsMsg}`);
            }
          }
        }
      },
      default: "apply"
    }, { width: 580 }).render(true);
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
      <div style="font-family:Roboto,sans-serif;">
        <div style="color:#bbb; font-size:12px; margin-bottom:8px;">Total: <b>${totalHeal}</b> (puede incluir curación/PG temp/PG máx temp). Selecciona a quién aplicar:</div>
        ${resolved.map((r) => `
          <label style="display:flex; gap:8px; align-items:center; padding:6px 8px; border:1px solid #444; border-radius:8px; background:#1b1b1b; margin-bottom:6px; cursor:pointer;">
            <input type="checkbox" class="ol-heal-pick" data-uuid="${escapeHtml(r.uuid)}" checked>
            <span style="color:#eee; font-weight:700;">${escapeHtml(r.tName)}</span>
          </label>`).join("")}
      </div>`;

    new LegacyDialog({
      title: "Aplicar Curación",
      content,
      buttons: {
        apply: {
          label: "Aplicar",
          callback: async (html) => {
            const picks = [];
            html.find("input.ol-heal-pick").each((_, el) => { if (el.checked) picks.push(el.dataset.uuid); });
            if (!picks.length) return;

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
              btn.innerHTML = `<i class="fas fa-check"></i> Curación aplicada`;
              ui.notifications.info(`<strong>Curación aplicada:</strong><br>${detailsMsg}`);
            }
          }
        }
      },
      default: "apply"
    }, { width: 420 }).render(true);
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
        <div style="font-family:Roboto,sans-serif;">
          <div style="color:#bbb; font-size:12px; margin-bottom:8px;">Selecciona con qué objetivos quieres tirar la salvación:</div>
          ${pending.map((t) => `
            <label style="display:flex; gap:8px; align-items:center; padding:6px 8px; border:1px solid #444; border-radius:8px; background:#1b1b1b; margin-bottom:6px; cursor:pointer;">
              <input type="checkbox" class="ol-save-pick" data-uuid="${escapeHtml(t.actorUuid)}" checked>
              <span style="color:#eee; font-weight:700;">${escapeHtml(t.name)}</span>
            </label>`).join("")}
        </div>`;
      const selectedUuids = await new Promise((res) => {
        new LegacyDialog({
          title: game.i18n.localize("OLATTACK.SaveRoll"),
          content,
          buttons: {
            ok: { label: "Tirar", callback: (html) => {
              const picks = [];
              html.find("input.ol-save-pick").each((_, el) => { if (el.checked) picks.push(el.dataset.uuid); });
              res(picks);
            }},
            cancel: { label: game.i18n.localize("OLATTACK.Cancel"), callback: () => res([]) }
          },
          default: "ok"
        }, { width: 420 }).render(true);
      });
      chosen = pending.filter((t) => selectedUuids.includes(t.actorUuid));
      if (!chosen.length) return ui.notifications.warn("⚠️ No has seleccionado objetivos.");
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

      const badgeBg = success === null ? "#f4f4f4" : success ? "#e8f5e9" : "#ffebee";
      const badgeColor = success === null ? "#666" : success ? "#2e7d32" : "#c62828";
      const badgeBorder = success === null ? "#ddd" : success ? "#a5d6a7" : "#ef9a9a";
      const badgeText = success === null ? "—" : success ? "ÉXITO" : "FALLO";
      const noticesHtml = Array.isArray(autoResult?.notices) && autoResult.notices.length
        ? `<div style="padding:0 18px 12px 18px;font-size:11px;color:#5b3e00;">${autoResult.notices.map((note) => `<div>⚙️ ${escapeHtml(note)}</div>`).join("")}</div>`
        : "";

      rowsHtml += `
        <div style="background:#fff;border-radius:10px;border:1px solid #e8e0d8;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04);position:relative;margin-bottom:10px;">
          <div style="position:absolute;left:0;top:0;bottom:0;width:5px;background:#b71c1c;border-radius:10px 0 0 10px;"></div>
          <div style="display:flex;align-items:center;padding:12px 14px 12px 18px;gap:12px;">
            <div style="flex:1;min-width:0;overflow:hidden;">
              <div style="font-weight:700;font-size:15px;color:#1a1a1a;margin:0 0 3px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div>
              <div style="font-size:11px;color:#777;">${escapeHtml(game.user.name)} · <code style="font-weight:700;">${escapeHtml(roll.formula)}</code></div>
            </div>
            <div style="min-width:52px;text-align:center;font-weight:800;font-size:24px;color:#1a1a1a;padding:8px 12px;background:#f0ebe5;border-radius:8px;border:1px solid #e0d8d0;">${total ?? "—"}</div>
            <div style="min-width:76px;text-align:center;padding:7px 14px;border-radius:999px;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.3px;background:${badgeBg};color:${badgeColor};border:1px solid ${badgeBorder};">${badgeText}</div>
          </div>
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
      await message.setFlag(FLAG_SCOPE, FLAG_KEY, {
        ...liveData,
        targets: remainingTargets,
        targetsMeta: remainingTargetsMeta,
        strictTargets: true
      });
    }

    const timingText = timing === "post" ? "después" : "antes";
    const abilityLabel = translateAbility(abil);

    const saveCardHtml = `
      <div style="font-family:'Roboto',sans-serif;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,0.15);max-width:420px;margin:0 auto;">
        <div style="background:linear-gradient(135deg,#5a1a1a 0%,#3d1212 100%);color:#fff;padding:14px 16px;">
          <h3 style="font-size:15px;font-weight:800;text-transform:uppercase;letter-spacing:0.8px;margin:0 0 6px 0;color:#fff;">Tirada de Salvación</h3>
          <p style="font-size:14px;font-weight:500;color:rgba(255,255,255,0.9);margin:0;">${escapeHtml(data.itemName || "Efecto")}</p>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;padding:10px 16px;background:linear-gradient(135deg,#5a1a1a 0%,#3d1212 100%);border-top:1px solid rgba(255,255,255,0.1);">
          <span style="display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;background:rgba(255,255,255,0.15);font-size:12px;color:#fff;font-weight:500;"><i class="fas fa-shield-alt" style="font-size:11px;opacity:0.9;"></i> ${escapeHtml(abilityLabel)} CD ${escapeHtml(dcLabel)}</span>
          <span style="display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;background:rgba(255,255,255,0.15);font-size:12px;color:#fff;font-weight:500;"><i class="fas fa-clock" style="font-size:11px;opacity:0.9;"></i> Se resuelve ${timingText} del daño</span>
        </div>
        <div style="padding:12px 16px;background:#faf8f6;">${rowsHtml}</div>
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

  await message.setFlag(FLAG_SCOPE, FLAG_KEY, { ...liveData, specialResolved: choice });
  btn.closest('.card-buttons')?.querySelectorAll('button.ol-divine-spark-choice')?.forEach((b) => { b.disabled = true; });
}

export function registerChatHandlers() {
  Hooks.on("renderChatMessage", (message, html) => {
    const data = getMsgData(message);
    if (!data || !Object.keys(data).length) return;

    // Marcar chat como GM para mostrar controles GM-only via CSS
    if (game.user.isGM) html.addClass("ol-chat-is-gm");

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
