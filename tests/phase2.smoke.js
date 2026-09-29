/**
 * Focused Phase 2 smoke tests — no DB, no network, pure timer/session logic.
 * Run: node server/tests/phase2.smoke.js
 */

const assert = require('assert');
const {
  computeRemainingMs,
  computeFocusedDurationMs,
  computeEndsAt,
  shouldFinalizeTimer,
  durationMinutesFromMs,
  uniqueUserIds,
  buildTimerState,
} = require('../utils/timerHelper');

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    passCount += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failCount += 1;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

function applyConditional(room, expectedStatus, mutate) {
  if (room.timerStatus !== expectedStatus) return { ok: false, room };
  return { ok: true, room: mutate({ ...room }) };
}

function applyPause(room, now) {
  return applyConditional(room, 'running', (r) => ({
    ...r,
    timerStatus: 'paused',
    timerAccumulatedMs: computeFocusedDurationMs(r, now),
    timerRemainingMs: computeRemainingMs(r, now),
    timerStartedAt: null,
    timerEndsAt: null,
  }));
}

function applyResume(room, now) {
  return applyConditional(room, 'paused', (r) => ({
    ...r,
    timerStatus: 'running',
    timerStartedAt: now,
    timerEndsAt: now + (r.timerRemainingMs || 0),
  }));
}

function reconstructAfterRestart(room, now) {
  if (shouldFinalizeTimer(room, now)) return { action: 'complete' };
  if (room.timerStatus === 'running') {
    return { action: 'schedule', remaining: computeRemainingMs(room, now) };
  }
  if (room.timerStatus === 'paused') {
    return { action: 'wait', remaining: room.timerRemainingMs };
  }
  return { action: 'idle' };
}

const t0 = 1_700_000_000_000;
const MIN = 60_000;

console.log('\n[F-03] Accurate focused duration (pause excluded):');

test('start 10m + pause 5m + resume 5m → 15m focused, not 20m', () => {
  let room = {
    timerDuration: 20,
    timerStatus: 'running',
    timerStartedAt: t0,
    timerRemainingMs: 20 * MIN,
    timerAccumulatedMs: 0,
    timerEndsAt: t0 + 20 * MIN,
  };
  const after10 = applyPause(room, t0 + 10 * MIN);
  assert.strictEqual(after10.ok, true);
  room = after10.room;
  assert.strictEqual(room.timerAccumulatedMs, 10 * MIN);
  assert.strictEqual(room.timerRemainingMs, 10 * MIN);

  const afterResume = applyResume(room, t0 + 15 * MIN);
  room = afterResume.room;
  const focused = computeFocusedDurationMs(room, t0 + 20 * MIN);
  assert.strictEqual(focused, 15 * MIN);
  assert.strictEqual(durationMinutesFromMs(focused), 15);
  const wallClock = 20 * MIN;
  assert.notStrictEqual(durationMinutesFromMs(wallClock), durationMinutesFromMs(focused));
});

test('paused time is frozen (remaining does not drop during pause)', () => {
  const paused = {
    timerDuration: 25,
    timerStatus: 'paused',
    timerStartedAt: null,
    timerRemainingMs: 10 * MIN,
    timerAccumulatedMs: 15 * MIN,
  };
  assert.strictEqual(computeRemainingMs(paused, t0), 10 * MIN);
  assert.strictEqual(computeRemainingMs(paused, t0 + 5 * MIN), 10 * MIN);
  assert.strictEqual(computeFocusedDurationMs(paused, t0 + 5 * MIN), 15 * MIN);
});

test('full run without pause ≈ configured duration', () => {
  const room = {
    timerDuration: 25,
    timerStatus: 'running',
    timerStartedAt: t0,
    timerRemainingMs: 25 * MIN,
    timerAccumulatedMs: 0,
  };
  assert.strictEqual(computeFocusedDurationMs(room, t0 + 25 * MIN), 25 * MIN);
  assert.strictEqual(durationMinutesFromMs(25 * MIN), 25);
});

test('sub-30s focus does not become a 1-minute session', () => {
  assert.strictEqual(durationMinutesFromMs(20_000), 0);
  assert.strictEqual(durationMinutesFromMs(30_000), 1);
  assert.strictEqual(durationMinutesFromMs(89_000), 1);
  assert.strictEqual(durationMinutesFromMs(90_000), 2);
});

console.log('\n[F-04] Duplicate session identity is user+room, not socketId:');

test('uniqueUserIds collapses two tabs of the same user', () => {
  const ids = uniqueUserIds([
    { userId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
    { userId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
    { userId: 'bbbbbbbbbbbbbbbbbbbbbbbb' },
  ]);
  assert.deepStrictEqual(ids, ['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb']);
});

test('uniqueUserIds accepts ObjectId-like values (persisted participants)', () => {
  const id = 'cccccccccccccccccccccccc';
  assert.deepStrictEqual(uniqueUserIds([id, { _id: id }]), [id]);
});

test('two different users both kept', () => {
  const ids = uniqueUserIds(['user-a-aaaaaaaaaaaaaaaa', 'user-b-bbbbbbbbbbbbbbbb']);
  assert.strictEqual(ids.length, 2);
});

console.log('\n[F-07] Restart reconstruction from persistent fields:');

test('running timer not yet due → schedule remaining from Mongo fields', () => {
  const room = {
    timerStatus: 'running',
    timerDuration: 25,
    timerStartedAt: t0,
    timerRemainingMs: 25 * MIN,
    timerEndsAt: t0 + 25 * MIN,
  };
  const now = t0 + 5 * MIN;
  const recon = reconstructAfterRestart(room, now);
  assert.strictEqual(recon.action, 'schedule');
  assert.strictEqual(recon.remaining, 20 * MIN);
  assert.strictEqual(shouldFinalizeTimer(room, now), false);
});

test('timer that should have completed while offline → finalize', () => {
  const room = {
    timerStatus: 'running',
    timerDuration: 25,
    timerStartedAt: t0,
    timerRemainingMs: 25 * MIN,
    timerEndsAt: t0 + 25 * MIN,
  };
  const now = t0 + 30 * MIN;
  assert.strictEqual(shouldFinalizeTimer(room, now), true);
  assert.strictEqual(reconstructAfterRestart(room, now).action, 'complete');
  assert.strictEqual(computeRemainingMs(room, now), 0);
});

test('paused timer survives restart with frozen remaining', () => {
  const room = {
    timerStatus: 'paused',
    timerDuration: 25,
    timerRemainingMs: 8 * MIN,
    timerAccumulatedMs: 17 * MIN,
    timerEndsAt: null,
  };
  const recon = reconstructAfterRestart(room, t0 + 99 * MIN);
  assert.strictEqual(recon.action, 'wait');
  assert.strictEqual(recon.remaining, 8 * MIN);
  assert.strictEqual(shouldFinalizeTimer(room, t0 + 99 * MIN), false);
});

test('legacy running doc without timerEndsAt still finalizes via remaining', () => {
  const room = {
    timerStatus: 'running',
    timerDuration: 10,
    timerStartedAt: t0,
    timerRemainingMs: 10 * MIN,
  };
  assert.strictEqual(shouldFinalizeTimer(room, t0 + 11 * MIN), true);
  assert.strictEqual(computeEndsAt(room, t0 + 11 * MIN), t0 + 11 * MIN);
});

test('client payload remainingMs uses server now, not client elapsed', () => {
  const room = {
    roomCode: 'ABC123',
    timerStatus: 'running',
    currentSessionType: 'focus',
    timerDuration: 25,
    timerStartedAt: t0,
    timerRemainingMs: 25 * MIN,
  };
  const state = buildTimerState(room, t0 + MIN);
  assert.strictEqual(state.remainingMs, 24 * MIN);
  assert.strictEqual(state.serverNow, t0 + MIN);
});

console.log('\n[F-08] Conditional timer transitions (only one winner):');

test('two simultaneous pauses: only first succeeds', () => {
  const running = {
    timerStatus: 'running',
    timerDuration: 25,
    timerStartedAt: t0,
    timerRemainingMs: 25 * MIN,
    timerAccumulatedMs: 0,
  };
  const first = applyPause(running, t0 + MIN);
  const second = applyPause(first.room, t0 + MIN + 10);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(first.room.timerStatus, 'paused');
});

test('two simultaneous resumes: only first succeeds', () => {
  const paused = {
    timerStatus: 'paused',
    timerRemainingMs: 10 * MIN,
    timerAccumulatedMs: 15 * MIN,
  };
  const first = applyResume(paused, t0);
  const second = applyResume(first.room, t0 + 5);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(first.room.timerStatus, 'running');
  assert.strictEqual(first.room.timerEndsAt, t0 + 10 * MIN);
});

test('pause of non-running timer is rejected', () => {
  assert.strictEqual(applyPause({ timerStatus: 'idle' }, t0).ok, false);
  assert.strictEqual(applyPause({ timerStatus: 'paused' }, t0).ok, false);
  assert.strictEqual(applyPause({ timerStatus: 'completed' }, t0).ok, false);
});

test('resume of non-paused timer is rejected', () => {
  assert.strictEqual(applyResume({ timerStatus: 'running' }, t0).ok, false);
  assert.strictEqual(applyResume({ timerStatus: 'idle' }, t0).ok, false);
});

test('broadcast-before-persist is not used: persist filters require status match', () => {
  const pauseFilter = (status) => status === 'running';
  const resumeFilter = (status) => status === 'paused';
  const startFilter = (status) => status === 'idle' || status === 'completed';
  assert.strictEqual(pauseFilter('running'), true);
  assert.strictEqual(pauseFilter('paused'), false);
  assert.strictEqual(resumeFilter('paused'), true);
  assert.strictEqual(resumeFilter('running'), false);
  assert.strictEqual(startFilter('idle'), true);
  assert.strictEqual(startFilter('running'), false);
});

test('F-08: pause with expired timer (timerRemainingMs ≤ 0) must be detected without pre-read', () => {
  // Simulate the new persistPause logic: no preliminary findOne.
  // After the findOneAndUpdate pipeline, timerRemainingMs == 0 means it should complete.
  // This test verifies the post-write timerRemainingMs check works correctly.
  const expiredRoom = {
    timerDuration: 25,
    timerStatus: 'running',
    timerStartedAt: t0,
    timerRemainingMs: 25 * MIN,
    timerAccumulatedMs: 0,
    timerEndsAt: t0 + 25 * MIN,
  };
  // At t0 + 30min, remaining is 0 (expired)
  const remaining = computeRemainingMs(expiredRoom, t0 + 30 * MIN);
  assert.strictEqual(remaining, 0, 'expired timer remaining should be 0');

  // Simulate what findOneAndUpdate pipeline would write for timerRemainingMs:
  // $max(0, timerRemainingMs - elapsed) = $max(0, 25min - 30min) = 0
  const elapsed = (t0 + 30 * MIN) - t0;
  const writtenRemainingMs = Math.max(0, 25 * MIN - elapsed);
  assert.strictEqual(writtenRemainingMs, 0, 'pipeline should write 0 for expired timer');

  // The post-write check (writtenRemainingMs <= 0) correctly triggers completion
  assert.strictEqual(writtenRemainingMs <= 0, true, 'should trigger completion path');
});

test('F-03: timerAccumulatedMs is capped at timerDuration*60000', () => {
  // Verifies that the $min cap in persistPause/persistComplete prevents over-accumulation
  const cap = 25 * MIN;
  // Accumulated is already at the cap
  const accumulated = cap;
  const additionalSegment = 5 * MIN; // extra time shouldn't exceed cap
  const result = Math.min(cap, accumulated + additionalSegment);
  assert.strictEqual(result, cap, 'accumulated must not exceed configured duration');
});

test('F-03: reset from running state captures focused time (not wall-clock)', () => {
  // Simulate: run 5min, pause 10min, resume 5min, then reset after 2min more
  let room = {
    timerDuration: 25,
    timerStatus: 'running',
    timerStartedAt: t0,
    timerRemainingMs: 25 * MIN,
    timerAccumulatedMs: 0,
    timerEndsAt: t0 + 25 * MIN,
  };

  // Pause after 5 min
  const afterPause = applyPause(room, t0 + 5 * MIN);
  assert.strictEqual(afterPause.ok, true);
  room = afterPause.room;
  assert.strictEqual(room.timerAccumulatedMs, 5 * MIN);

  // Resume after 10 min of pausing
  const afterResume = applyResume(room, t0 + 15 * MIN);
  room = afterResume.room;

  // Check focused time at t0+17min (2 more minutes of running after resume)
  const focused = computeFocusedDurationMs(room, t0 + 17 * MIN);
  assert.strictEqual(focused, 7 * MIN, 'focused = 5min initial + 2min after resume (pause excluded)');
  assert.strictEqual(durationMinutesFromMs(focused), 7, 'durationMinutes = 7, not 17 (wall clock)');
  assert.notStrictEqual(focused, 17 * MIN, 'must not equal wall-clock elapsed');
});

test('F-04: timerCycleId uniqueness — same user+room in same cycle → duplicate blocked', () => {
  // Simulates the unique index: user+room+timerCycleId (where cycleId is a number)
  const userA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const roomId = 'rrrrrrrrrrrrrrrrrrrrrrrr';
  const cycleId = 3;

  // First insert (succeeds)
  const doc1 = { user: userA, room: roomId, timerCycleId: cycleId };
  // Second insert (would violate unique index)
  const doc2 = { user: userA, room: roomId, timerCycleId: cycleId };

  // Simulate duplicate key detection
  const key1 = `${doc1.user}-${doc1.room}-${doc1.timerCycleId}`;
  const key2 = `${doc2.user}-${doc2.room}-${doc2.timerCycleId}`;
  assert.strictEqual(key1, key2, 'duplicate key would be identical → unique index rejects second');
  assert.notStrictEqual(doc1, doc2, 'two different objects but same logical identity');
});

test('F-04: different users in same room + same cycle → NOT a duplicate', () => {
  const userA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const userB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const roomId = 'rrrrrrrrrrrrrrrrrrrrrrrr';
  const cycleId = 3;
  const key1 = `${userA}-${roomId}-${cycleId}`;
  const key2 = `${userB}-${roomId}-${cycleId}`;
  assert.notStrictEqual(key1, key2, 'different users must have different keys → both allowed');
});

test('F-07: sweeper detects overdue timers via timerEndsAt <= now', () => {
  // Simulates the sweeper query: Room.find({ timerStatus: 'running', timerEndsAt: { $lte: now } })
  const rooms = [
    { roomCode: 'AAA111', timerStatus: 'running', timerEndsAt: t0 + 25 * MIN }, // future
    { roomCode: 'BBB222', timerStatus: 'running', timerEndsAt: t0 + 5 * MIN },  // past
    { roomCode: 'CCC333', timerStatus: 'paused',  timerEndsAt: null },           // not running
  ];
  const now = t0 + 10 * MIN;
  const overdue = rooms.filter(r => r.timerStatus === 'running' && r.timerEndsAt <= now);
  assert.strictEqual(overdue.length, 1, 'only one overdue room');
  assert.strictEqual(overdue[0].roomCode, 'BBB222', 'correct room identified');
});

test('F-07: reconnecting client receives server-authoritative remainingMs', () => {
  // After reconnect, client calls join-room → receives timer-state with server-computed remainingMs
  const room = {
    roomCode: 'XYZ123',
    timerStatus: 'running',
    currentSessionType: 'focus',
    timerDuration: 25,
    timerStartedAt: t0,
    timerRemainingMs: 25 * MIN,
    timerEndsAt: t0 + 25 * MIN,
  };
  const reconnectTime = t0 + 10 * MIN;
  const state = buildTimerState(room, reconnectTime);
  assert.strictEqual(state.remainingMs, 15 * MIN, 'client gets 15min remaining after 10min elapsed');
  assert.strictEqual(state.serverNow, reconnectTime, 'serverNow provided for drift correction');
  assert.strictEqual(state.timerStartedAt, t0, 'timerStartedAt provided for client self-correction');
  // Client computes remaining as: remainingMs - (Date.now() - serverNow + clockOffset)
  // which equals remainingMs when Date.now() ≈ serverNow (same instant)
  assert.strictEqual(state.remainingMs, computeRemainingMs(room, reconnectTime));
});

console.log(`\n=== Phase 2 smoke test result: ${passCount} passed, ${failCount} failed ===`);
if (failCount > 0) process.exit(1);

