import { MODULE_ID, SETTING_DAMAGE_LEDGER_STATE, SOCKET_NS } from "../shared/constants.js";
import { safeNum, translateDamageType } from "./utils.js";
import { applyDamageToActor } from "./damage.js";
import { getActorHpData } from "../shared/system-data.js";

const FALLBACK_IMG = "icons/svg/mystery-man.svg";
const MAX_LINES = 200;
const MAX_PROCESSED = 700;

let state = null;
let registered = false;

function clone(value) {
  return foundry.utils.deepClone(value);
}

function makeId() {
  return foundry?.utils?.randomID?.() || crypto.randomUUID();
}

function normalizeState(raw = {}) {
  return {
    active: raw.active !== false,
    lines: Array.isArray(raw.lines) ? raw.lines : [],
    deletedStack: Array.isArray(raw.deletedStack) ? raw.deletedStack : [],
    processedKeys: Array.isArray(raw.processedKeys) ? raw.processedKeys : []
  };
}

function getState() {
  if (state) return state;
  try {
    state = normalizeState(game.settings.get(MODULE_ID, SETTING_DAMAGE_LEDGER_STATE) || {});
  } catch (_) {
    state = normalizeState();
  }
  return state;
}

async function saveState() {
  const st = getState();
  st.processedKeys = Array.from(new Set(st.processedKeys)).slice(-MAX_PROCESSED);
  st.lines = st.lines.slice(0, MAX_LINES);
  try {
    await game.settings.set(MODULE_ID, SETTING_DAMAGE_LEDGER_STATE, clone(st));
  } catch (_) {}
}

function renderTrackers() {
  try { game.olAttack?._sceneTracker?.rendered && game.olAttack._sceneTracker.render(true); } catch (_) {}
}

function tokenImage(tokenDocOrToken = null, actor = null) {
  return tokenDocOrToken?.texture?.src
    || tokenDocOrToken?.document?.texture?.src
    || actor?.img
    || tokenDocOrToken?.actor?.img
    || FALLBACK_IMG;
}

function entityDataFromActor(actor, token = null, fallback = "Origen") {
  const activeToken = token || actor?.getActiveTokens?.()?.[0] || null;
  return {
    name: activeToken?.name || actor?.name || fallback,
    img: tokenImage(activeToken, actor),
    actorUuid: actor?.uuid || null,
    tokenUuid: activeToken?.document?.uuid || activeToken?.uuid || null
  };
}

function entityDataFromTarget(target) {
  const tokenDoc = target?.document || target?.tokDoc || target || null;
  const actor = target?.actor || tokenDoc?.actor || null;
  return {
    name: target?.name || tokenDoc?.name || actor?.name || "Objetivo",
    img: target?.img || tokenImage(tokenDoc, actor),
    actorUuid: actor?.uuid || target?.actorUuid || null,
    tokenUuid: tokenDoc?.uuid || target?.tokenUuid || null
  };
}

function amountFromParts(parts = []) {
  return parts.reduce((sum, part) => sum + safeNum(part?.amount, 0), 0);
}

function firstType(parts = []) {
  const raw = String(parts.find((p) => p?.type)?.type || "damage");
  return raw || "damage";
}

function compactFormula(parts = []) {
  return parts.map((part) => String(part?.formula || "").trim()).filter(Boolean).join(" + ");
}

function markProcessed(key) {
  const st = getState();
  if (!st.processedKeys.includes(key)) st.processedKeys.push(key);
}

function hasProcessed(key) {
  return getState().processedKeys.includes(key);
}

function lineStatus(line) {
  if (line?.deleted) return "deleted";
  if (line?.status === "applied") return "applied";
  return "pending";
}

function lineStatusText(line) {
  const status = lineStatus(line);
  if (status === "deleted") return "Borr.";
  if (status === "applied" && line.appliedBy === "chat") return "Chat";
  if (status === "applied") return "Aplic.";
  return "Pend.";
}

function sameActorOrToken(line, actorUuid, tokenUuid) {
  if (tokenUuid && line?.target?.tokenUuid === tokenUuid) return true;
  if (actorUuid && line?.target?.actorUuid === actorUuid) return true;
  return false;
}

function recentEquivalentExists(candidate) {
  const now = Date.now();
  return getState().lines.some((line) => {
    if (!sameActorOrToken(line, candidate.target?.actorUuid, candidate.target?.tokenUuid)) return false;
    if (line.source?.actorUuid !== candidate.source?.actorUuid) return false;
    if (safeNum(line.amount, 0) !== safeNum(candidate.amount, 0)) return false;
    return now - safeNum(line.createdAt, 0) < 4500;
  });
}

export function registerDamageLedger() {
  if (registered) return;
  registered = true;
  getState();
}

export async function addPendingDamageLines(payload = {}, { remote = false } = {}) {
  const parts = Array.isArray(payload.parts) ? payload.parts : Array.isArray(payload.damages) ? payload.damages : [];
  const cleanParts = parts
    .map((part) => ({
      amount: Math.max(0, Math.floor(safeNum(part?.amount, 0))),
      type: String(part?.type || "bludgeoning"),
      formula: String(part?.formula || ""),
      label: String(part?.label || "")
    }))
    .filter((part) => part.amount > 0);

  if (!cleanParts.length) return 0;

  if (!remote && !game.user?.isGM) {
    game.socket?.emit?.(SOCKET_NS, { type: "damageLedgerAdd", payload: clone({ ...payload, parts: cleanParts }) });
  }

  const st = getState();
  if (!st.active) return 0;

  const source = payload.source || entityDataFromActor(payload.actor, payload.token, payload.itemName || "Origen");
  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  const amount = Math.floor(amountFromParts(cleanParts));
  if (!amount || !targets.length) return 0;

  let added = 0;
  for (const targetRaw of targets) {
    const target = payload.target || entityDataFromTarget(targetRaw);
    if (!target?.actorUuid && !target?.tokenUuid) continue;

    const key = [
      payload.messageId || payload.keyBase || Date.now(),
      source.actorUuid || "source",
      target.tokenUuid || target.actorUuid || "target",
      amount,
      cleanParts.map((p) => `${p.amount}:${p.type}`).join("|")
    ].join(":");

    if (hasProcessed(key)) continue;

    const line = {
      id: makeId(),
      key,
      createdAt: Date.now(),
      source,
      target,
      amount,
      parts: clone(cleanParts),
      formula: compactFormula(cleanParts),
      label: String(payload.label || payload.itemName || "Daño"),
      damageType: payload.damageType || firstType(cleanParts),
      status: "pending",
      deleted: false,
      appliedBy: null,
      before: null,
      after: null,
      systemMode: payload.systemMode || "normal",
      attackTags: Array.isArray(payload.attackTags) ? payload.attackTags : []
    };

    if (recentEquivalentExists(line)) {
      markProcessed(key);
      continue;
    }

    markProcessed(key);
    st.lines.unshift(line);
    added += 1;
  }

  if (added) {
    await saveState();
    renderTrackers();
  }
  return added;
}

function findBestPendingLine({ actorUuid = null, tokenUuid = null, amount = 0 } = {}) {
  const pending = getState().lines
    .filter((line) => !line.deleted && line.status !== "applied" && sameActorOrToken(line, actorUuid, tokenUuid))
    .sort((a, b) => safeNum(b.createdAt, 0) - safeNum(a.createdAt, 0));
  if (!pending.length) return null;
  const targetAmount = Math.max(0, Math.floor(safeNum(amount, 0)));
  return pending.find((line) => Math.floor(safeNum(line.amount, 0)) === targetAmount) || pending[0];
}

export async function markPendingDamageApplied(payload = {}, { remote = false } = {}) {
  if (!remote && !game.user?.isGM) {
    game.socket?.emit?.(SOCKET_NS, { type: "damageLedgerApplied", payload: clone(payload) });
  }

  const actorUuid = payload.actorUuid || payload.targetActor?.uuid || null;
  const tokenUuid = payload.tokenUuid || payload.targetUuid || null;
  const amount = payload.originalAmount || payload.amount || payload.appliedTotal || 0;
  const line = findBestPendingLine({ actorUuid, tokenUuid, amount });
  if (!line) return false;

  const actor = payload.targetActor || (actorUuid ? await fromUuid(actorUuid).catch(() => null) : null);
  line.status = "applied";
  line.appliedAt = Date.now();
  line.appliedBy = payload.source || "chat";
  line.externalAppliedAmount = safeNum(payload.appliedTotal, 0);
  line.after = actor ? getActorHpData(actor) : null;

  await saveState();
  renderTrackers();
  return true;
}

export function getDamageLedgerView() {
  const st = getState();
  const lines = st.lines || [];
  const pending = lines.filter((line) => !line.deleted && line.status !== "applied");
  const applied = lines.filter((line) => !line.deleted && line.status === "applied");
  const deleted = lines.filter((line) => line.deleted);
  const pendingTotal = pending.reduce((sum, line) => sum + safeNum(line.amount, 0), 0);

  return {
    active: st.active,
    hasLines: lines.length > 0,
    pendingCount: pending.length,
    appliedCount: applied.length,
    deletedCount: deleted.length,
    pendingTotal,
    canApply: pending.length > 0,
    lines: lines.slice(0, 80).map((line) => ({
      ...line,
      statusClass: lineStatus(line),
      statusText: lineStatusText(line),
      sourceName: line.source?.name || "Origen",
      sourceImg: line.source?.img || FALLBACK_IMG,
      targetName: line.target?.name || "Objetivo",
      targetImg: line.target?.img || FALLBACK_IMG,
      damageTypeLabel: translateDamageType(line.damageType || firstType(line.parts)),
      formulaLabel: line.formula || compactFormula(line.parts),
      canDelete: !line.deleted,
      canRestore: !!line.deleted,
      canApplyLine: !line.deleted && line.status !== "applied"
    }))
  };
}

export async function toggleDamageLedgerActive() {
  const st = getState();
  st.active = !st.active;
  await saveState();
  renderTrackers();
  return st.active;
}

export async function deleteDamageLedgerLine(lineId) {
  const line = getState().lines.find((entry) => entry.id === lineId);
  if (!line) return;
  line.deleted = true;
  line.deletedAt = Date.now();
  getState().deletedStack.push(line.id);
  await saveState();
  renderTrackers();
}

export async function restoreDamageLedgerLine(lineId) {
  const line = getState().lines.find((entry) => entry.id === lineId);
  if (!line) return;
  line.deleted = false;
  line.deletedAt = null;
  await saveState();
  renderTrackers();
}

export async function undoDamageLedgerDelete() {
  const st = getState();
  while (st.deletedStack.length) {
    const lineId = st.deletedStack.pop();
    const line = st.lines.find((entry) => entry.id === lineId);
    if (!line?.deleted) continue;
    line.deleted = false;
    line.deletedAt = null;
    await saveState();
    renderTrackers();
    return true;
  }
  return false;
}

export async function clearDamageLedgerApplied() {
  const st = getState();
  st.lines = st.lines.filter((line) => line.status !== "applied");
  await saveState();
  renderTrackers();
}

export async function clearDamageLedgerAll() {
  const st = getState();
  st.lines = [];
  st.deletedStack = [];
  st.processedKeys = [];
  await saveState();
  renderTrackers();
}

async function resolveLineActor(line) {
  const tokenDoc = line?.target?.tokenUuid ? await fromUuid(line.target.tokenUuid).catch(() => null) : null;
  return tokenDoc?.actor || (line?.target?.actorUuid ? await fromUuid(line.target.actorUuid).catch(() => null) : null);
}

export async function applyDamageLedgerLine(lineId) {
  const line = getState().lines.find((entry) => entry.id === lineId);
  if (!line || line.deleted || line.status === "applied") return null;

  const actor = await resolveLineActor(line);
  if (!actor) throw new Error(`No se ha encontrado el actor de ${line.target?.name || "objetivo"}.`);
  if (!game.user?.isGM && !actor.isOwner) throw new Error(`No tienes permiso para modificar a ${actor.name}.`);

  const before = getActorHpData(actor);
  const details = [];
  let totalApplied = 0;
  const isHomebrew = line.systemMode === "homebrew";

  for (const part of line.parts || []) {
    const amount = Math.max(0, Math.floor(safeNum(part.amount, 0)));
    if (!amount) continue;
    const res = await applyDamageToActor(actor, amount, part.type || line.damageType || "bludgeoning", {
      homebrew: isHomebrew,
      attackTags: Array.isArray(line.attackTags) ? line.attackTags : []
    });
    totalApplied += safeNum(res?.applied, 0);
    details.push(`${amount}->${safeNum(res?.applied, 0)} ${part.type || line.damageType || "damage"}${res?.modified ? ` (${res.modifier || ""})` : ""}`);
  }

  line.status = "applied";
  line.appliedAt = Date.now();
  line.appliedBy = "monitor";
  line.before = before;
  line.after = getActorHpData(actor);
  line.externalAppliedAmount = totalApplied;

  await saveState();
  renderTrackers();

  return {
    ok: true,
    source: line.source?.name || "Origen",
    target: line.target?.name || actor.name,
    amount: line.amount,
    applied: totalApplied,
    details
  };
}

export async function applyAllPendingDamageLedger() {
  const pending = getState().lines.filter((line) => !line.deleted && line.status !== "applied");
  const results = [];
  for (const line of pending) {
    try {
      results.push(await applyDamageLedgerLine(line.id));
    } catch (err) {
      console.warn("[ol-attack] No se pudo aplicar daño pendiente", err);
      results.push({ ok: false, target: line.target?.name || "Objetivo", amount: line.amount, error: err?.message || String(err) });
    }
  }
  const ok = results.filter((r) => r?.ok).length;
  const failed = results.length - ok;
  if (ok) ui.notifications?.info?.(`Daño pendiente aplicado: ${ok} línea(s).`);
  if (failed) ui.notifications?.warn?.(`${failed} línea(s) no se pudieron aplicar.`);
  return results;
}
