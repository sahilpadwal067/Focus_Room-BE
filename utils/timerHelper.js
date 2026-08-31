/**
 * Pure timer helper functions — no side effects, no DB calls.
 * All durations are in milliseconds unless noted.
 */

/**
 * Compute how many milliseconds remain right now for a room.
 * Returns the full duration if the timer has never been started.
 */
function computeRemainingMs(room) {
  const totalMs = room.timerDuration * 60 * 1000;

  if (room.timerStatus === 'idle') {
    return totalMs;
  }

  if (room.timerStatus === 'paused' || room.timerStatus === 'completed') {
    return room.timerRemainingMs ?? totalMs;
  }

  if (room.timerStatus === 'running') {
    const elapsed = Date.now() - (room.timerStartedAt ?? Date.now());
    const base = room.timerRemainingMs ?? totalMs;
    return Math.max(0, base - elapsed);
  }

  return totalMs;
}

/**
 * Build the canonical timer-state payload sent to clients.
 * Clients use remainingMs + serverNow to stay in sync without drift.
 */
function buildTimerState(room) {
  return {
    roomCode: room.roomCode,
    timerStatus: room.timerStatus,
    currentSessionType: room.currentSessionType,
    timerDuration: room.timerDuration,    // minutes
    remainingMs: computeRemainingMs(room),
    timerStartedAt: room.timerStartedAt,  // so client can self-correct
    serverNow: Date.now(),                // reference epoch for client drift correction
  };
}

module.exports = { computeRemainingMs, buildTimerState };
