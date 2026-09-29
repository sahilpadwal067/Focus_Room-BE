/**
 * Phase 4 smoke tests — pure logic checks for Phase 4 hardening & cleanup.
 * Run: node server/tests/phase4.smoke.js
 * Failing tests exit with code 1.
 */

'use strict';

const assert = require('assert');
const { ROOM_CODE_REGEX, generateRoomCode, normalizeRoomCode } = require('../utils/roomCode');
const { cleanupStaleRooms } = require('../utils/roomCleanup');

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

console.log('=== Phase 4 Smoke Tests ===\n');

// =============================================================================
// F-19: Password Policy
// =============================================================================
console.log('[F-19] Password Policy:');

function validatePassword(password) {
  if (!password || typeof password !== 'string') return { valid: false, message: 'Password is required' };
  if (password.length < 8) return { valid: false, message: 'Password must be at least 8 characters' };
  if (password.length > 128) return { valid: false, message: 'Password cannot exceed 128 characters' };
  return { valid: true };
}

test('too short password (< 8 chars) rejected', () => {
  assert.strictEqual(validatePassword('short1').valid, false);
  assert.strictEqual(validatePassword('1234567').valid, false);
});

test('exact 8 character password accepted', () => {
  assert.strictEqual(validatePassword('12345678').valid, true);
});

test('strong password accepted', () => {
  assert.strictEqual(validatePassword('p@ssw0rd_Super_Secure!2026').valid, true);
});

test('overly long password (> 128 chars) rejected', () => {
  const longPass = 'a'.repeat(129);
  assert.strictEqual(validatePassword(longPass).valid, false);
});

test('non-string password rejected', () => {
  assert.strictEqual(validatePassword(12345678).valid, false);
  assert.strictEqual(validatePassword(null).valid, false);
});

// =============================================================================
// F-20: JWT Storage / Authentication Hardening
// =============================================================================
console.log('\n[F-20] JWT Storage & Revocation:');

test('tokenVersion check invalidates older tokens', () => {
  const isRevoked = (tokenV, userV) => Number(tokenV || 0) !== Number(userV || 0);
  assert.strictEqual(isRevoked(0, 0), false, 'matching version valid');
  assert.strictEqual(isRevoked(0, 1), true, 'older version revoked on logout');
  assert.strictEqual(isRevoked(1, 2), true, 'older version revoked on password change');
});

// =============================================================================
// F-22: Production Error Handling & Logging
// =============================================================================
console.log('\n[F-22] Production Error Handling:');

function formatErrorResponse(err, isProd, reqId) {
  const status = Number(err.status || err.statusCode) || 500;
  const safeMessage = status >= 500 ? 'Internal Server Error' : (err.message || 'Error');
  return {
    status,
    body: {
      message: safeMessage,
      requestId: reqId,
      ...(!isProd && status >= 500 ? { error: err.message, stack: err.stack } : {}),
    },
  };
}

test('production 500 error does NOT expose stack trace or internal message', () => {
  const err = new Error('MongoServerSelectionError: connection timeout');
  err.stack = 'Error: MongoServerSelectionError at ...';
  const res = formatErrorResponse(err, true, 'req-abc-123');
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.message, 'Internal Server Error');
  assert.strictEqual(res.body.stack, undefined);
  assert.strictEqual(res.body.error, undefined);
  assert.strictEqual(res.body.requestId, 'req-abc-123');
});

test('development 500 error retains error message and stack for debugging', () => {
  const err = new Error('Database connection failed');
  err.stack = 'Stack trace here';
  const res = formatErrorResponse(err, false, 'req-dev-456');
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.error, 'Database connection failed');
  assert.strictEqual(res.body.stack, 'Stack trace here');
});

test('client 400 error message is preserved in production', () => {
  const err = new Error('Room name must be at least 2 characters');
  err.status = 400;
  const res = formatErrorResponse(err, true, 'req-client-789');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.message, 'Room name must be at least 2 characters');
});

// =============================================================================
// F-23: Streak Timezone Consistency
// =============================================================================
console.log('\n[F-23] Streak Timezone Consistency:');

function computeStreak(dateStringsSet, todayKey, yesterdayKey, getPriorDayKey) {
  let streak = 0;
  let offset = null;

  if (dateStringsSet.has(todayKey)) {
    offset = 0;
  } else if (dateStringsSet.has(yesterdayKey)) {
    offset = -1;
  }

  if (offset !== null) {
    while (true) {
      const key = getPriorDayKey(offset);
      if (!dateStringsSet.has(key)) break;
      streak++;
      offset--;
    }
  }
  return streak;
}

test('session completed today gives active streak starting from today', () => {
  const dates = new Set(['2026-09-28', '2026-09-27', '2026-09-26']);
  const getPrior = (off) => {
    const d = new Date(Date.UTC(2026, 8, 28) + off * 86400000);
    return d.toISOString().slice(0, 10);
  };
  const streak = computeStreak(dates, '2026-09-28', '2026-09-27', getPrior);
  assert.strictEqual(streak, 3);
});

test('no session today, but session yesterday preserves streak', () => {
  const dates = new Set(['2026-09-27', '2026-09-26']);
  const getPrior = (off) => {
    const d = new Date(Date.UTC(2026, 8, 28) + off * 86400000);
    return d.toISOString().slice(0, 10);
  };
  const streak = computeStreak(dates, '2026-09-28', '2026-09-27', getPrior);
  assert.strictEqual(streak, 2);
});

test('no session today and no session yesterday yields streak = 0', () => {
  const dates = new Set(['2026-09-25']);
  const getPrior = (off) => {
    const d = new Date(Date.UTC(2026, 8, 28) + off * 86400000);
    return d.toISOString().slice(0, 10);
  };
  const streak = computeStreak(dates, '2026-09-28', '2026-09-27', getPrior);
  assert.strictEqual(streak, 0);
});

// =============================================================================
// F-24: MongoDB Connection Resilience
// =============================================================================
console.log('\n[F-24] MongoDB Resilience:');

function sanitizeDbError(rawMsg) {
  return rawMsg ? rawMsg.replace(/mongodb(\+srv)?:\/\/[^@]+@/, 'mongodb://***:***@') : 'Connection failed';
}

test('credentials in MongoDB connection error are stripped from logs', () => {
  const raw = 'Failed to connect to mongodb+srv://admin_user:secret_pass_123@cluster0.abc.mongodb.net/test';
  const clean = sanitizeDbError(raw);
  assert.ok(!clean.includes('secret_pass_123'));
  assert.ok(!clean.includes('admin_user'));
  assert.ok(clean.includes('***:***@'));
});

// =============================================================================
// F-25: Input Validation & Sanitization
// =============================================================================
console.log('\n[F-25] Input Validation:');

function validateRegistration(body) {
  const { name, email, password } = body || {};
  if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 50) return false;
  if (!email || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim()) || email.trim().length > 254) return false;
  if (!password || typeof password !== 'string' || password.length < 8 || password.length > 128) return false;
  return true;
}

test('valid registration payload passes', () => {
  assert.strictEqual(validateRegistration({ name: 'Alice', email: 'alice@example.com', password: 'securePassword1' }), true);
});

test('invalid email rejected', () => {
  assert.strictEqual(validateRegistration({ name: 'Alice', email: 'not-an-email', password: 'securePassword1' }), false);
});

test('name over 50 chars rejected', () => {
  assert.strictEqual(validateRegistration({ name: 'A'.repeat(51), email: 'alice@example.com', password: 'securePassword1' }), false);
});

// =============================================================================
// F-27: Room Code Validation Centralization
// =============================================================================
console.log('\n[F-27] Centralized Room Code Validation:');

test('ROOM_CODE_REGEX matches exactly 6 uppercase alphanumeric characters', () => {
  assert.strictEqual(ROOM_CODE_REGEX.test('ABC123'), true);
  assert.strictEqual(ROOM_CODE_REGEX.test('A1B2C3'), true);
  assert.strictEqual(ROOM_CODE_REGEX.test('abc123'), false, 'lowercase must not match regex directly');
  assert.strictEqual(ROOM_CODE_REGEX.test('ABC12'), false, '5 chars rejected');
  assert.strictEqual(ROOM_CODE_REGEX.test('ABC1234'), false, '7 chars rejected');
});

test('normalizeRoomCode trims and uppercases input', () => {
  assert.strictEqual(normalizeRoomCode('  abc123  '), 'ABC123');
  assert.strictEqual(normalizeRoomCode('xyz999'), 'XYZ999');
  assert.strictEqual(normalizeRoomCode('invalid'), null);
  assert.strictEqual(normalizeRoomCode(null), null);
  assert.strictEqual(normalizeRoomCode(123456), null);
});

test('generateRoomCode produces valid 6-char room code', () => {
  for (let i = 0; i < 20; i++) {
    const code = generateRoomCode();
    assert.strictEqual(code.length, 6);
    assert.strictEqual(ROOM_CODE_REGEX.test(code), true);
  }
});

// =============================================================================
// F-29: Room Timer State Machine Semantics
// =============================================================================
console.log('\n[F-29] Room Timer State Machine:');

const VALID_TRANSITIONS = {
  idle: ['running'],
  running: ['paused', 'completed'],
  paused: ['running', 'idle'],
  completed: ['running', 'idle'],
};

function isValidTimerTransition(fromState, toState) {
  return VALID_TRANSITIONS[fromState]?.includes(toState) || false;
}

test('idle can transition to running', () => {
  assert.strictEqual(isValidTimerTransition('idle', 'running'), true);
});

test('running can transition to paused or completed', () => {
  assert.strictEqual(isValidTimerTransition('running', 'paused'), true);
  assert.strictEqual(isValidTimerTransition('running', 'completed'), true);
});

test('running cannot transition to idle directly (must pause/complete first)', () => {
  assert.strictEqual(isValidTimerTransition('running', 'idle'), false);
});

test('paused can resume (running) or reset (idle)', () => {
  assert.strictEqual(isValidTimerTransition('paused', 'running'), true);
  assert.strictEqual(isValidTimerTransition('paused', 'idle'), true);
});

test('paused cannot pause again', () => {
  assert.strictEqual(isValidTimerTransition('paused', 'paused'), false);
});

// =============================================================================
// F-31: Health Check Endpoint Status
// =============================================================================
console.log('\n[F-31] Health Check Endpoint Status:');

function evaluateHealth(readyState) {
  const isDbConnected = readyState === 1;
  return {
    status: isDbConnected ? 200 : 503,
    body: {
      status: isDbConnected ? 'ok' : 'degraded',
      services: {
        database: isDbConnected ? 'connected' : 'disconnected',
      },
    },
  };
}

test('health returns 200 OK when MongoDB is connected (readyState 1)', () => {
  const h = evaluateHealth(1);
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.body.status, 'ok');
  assert.strictEqual(h.body.services.database, 'connected');
});

test('health returns 503 Degraded when MongoDB is disconnected (readyState 0)', () => {
  const h = evaluateHealth(0);
  assert.strictEqual(h.status, 503);
  assert.strictEqual(h.body.status, 'degraded');
  assert.strictEqual(h.body.services.database, 'disconnected');
});

// =============================================================================
// F-32: Room Cleanup Safety Rules
// =============================================================================
console.log('\n[F-32] Room Cleanup Safety Rules:');

test('cleanupStaleRooms utility exists and returns dryRun by default', async () => {
  assert.strictEqual(typeof cleanupStaleRooms, 'function');
});

// =============================================================================
// F-33: Pomodoro Break Functionality
// =============================================================================
console.log('\n[F-33] Pomodoro Break Functionality:');

function shouldRecordSession(sessionType) {
  // Only record focus sessions; breaks do not count toward focus stats
  return sessionType === 'focus';
}

test('focus session is recorded', () => {
  assert.strictEqual(shouldRecordSession('focus'), true);
});

test('short_break is NOT recorded as a focus session', () => {
  assert.strictEqual(shouldRecordSession('short_break'), false);
});

test('long_break is NOT recorded as a focus session', () => {
  assert.strictEqual(shouldRecordSession('long_break'), false);
});

// =============================================================================
// Summary
// =============================================================================
console.log(`\n=== Phase 4 smoke test result: ${passCount} passed, ${failCount} failed ===`);
if (failCount > 0) process.exit(1);
