/**
 * Pure timer helper functions — no side effects, no DB calls.
 * All durations are in milliseconds unless noted.
 */

function totalDurationMs(room) {
  return (Number(room.timerDuration) || 0) * 60 * 1000;
}

/**
 * Compute how many milliseconds remain right now for a room.
 * Returns the full duration if the timer has never been started.
 */
function computeRemainingMs(room, now = Date.now()) {
  const totalMs = totalDurationMs(room);

  if (room.timerStatus === 'idle') {
    return totalMs;
  }

  if (room.timerStatus === 'paused' || room.timerStatus === 'completed') {
    return room.timerRemainingMs ?? totalMs;
  }

  if (room.timerStatus === 'running') {
    const elapsed = now - (room.timerStartedAt ?? now);
    const base = room.timerRemainingMs ?? totalMs;
    return Math.max(0, base - elapsed);
  }

  return totalMs;
}

/**
 * Actual focused elapsed time for the current cycle (paused intervals excluded).
 */
function computeFocusedDurationMs(room, now = Date.now()) {
  const accumulated = Math.max(0, Number(room.timerAccumulatedMs) || 0);
  const cap = totalDurationMs(room) || Number.POSITIVE_INFINITY;

  if (room.timerStatus === 'running') {
    const segment = Math.max(0, now - (room.timerStartedAt ?? now));
    return Math.min(cap, accumulated + segment);
  }

  return Math.min(cap, accumulated);
}

/**
 * Epoch ms when the current running segment should hit zero.
 * Null when the timer is not running.
 */
function computeEndsAt(room, now = Date.now()) {
  if (room.timerStatus !== 'running') return null;
  const remaining = computeRemainingMs(room, now);
  return now + remaining;
}

function shouldFinalizeTimer(room, now = Date.now()) {
  if (!room || room.timerStatus !== 'running') return false;
  if (typeof room.timerEndsAt === 'number') {
    return room.timerEndsAt <= now;
  }
  return computeRemainingMs(room, now) <= 0;
}

/**
 * Dashboard stores whole minutes. Round actual elapsed focus time.
 * Returns 0 when there is not at least ~30s of focus (skip tiny/cancelled sessions).
 */
function durationMinutesFromMs(ms) {
  const n = Number(ms) || 0;
  if (n < 30_000) return 0;
  return Math.max(1, Math.round(n / 60_000));
}

function uniqueUserIds(entries) {
  const seen = new Set();
  const ids = [];
  for (const entry of entries || []) {
    const id = String(entry?.userId ?? entry?._id ?? entry ?? '');
    if (!id || id === 'undefined' || id === 'null') continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Build the canonical timer-state payload sent to clients.
 * Clients use remainingMs + serverNow to stay in sync without drift.
 */
function buildTimerState(room, now = Date.now()) {
  return {
    roomCode: room.roomCode,
    timerStatus: room.timerStatus,
    currentSessionType: room.currentSessionType,
    timerDuration: room.timerDuration,    // minutes
    remainingMs: computeRemainingMs(room, now),
    timerStartedAt: room.timerStartedAt,  // so client can self-correct
    serverNow: now,                       // reference epoch for client drift correction
  };
}

module.exports = {
  totalDurationMs,
  computeRemainingMs,
  computeFocusedDurationMs,
  computeEndsAt,
  shouldFinalizeTimer,
  durationMinutesFromMs,
  uniqueUserIds,
  buildTimerState,
};
