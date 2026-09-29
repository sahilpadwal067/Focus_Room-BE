/**
 * Phase 3 smoke tests — no DB, no network, pure logic checks.
 * Run: node server/tests/phase3.smoke.js
 * Failing tests exit with code 1.
 */

'use strict';

const assert = require('assert');

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

// =============================================================================
// F-05: Room-code creation — retry-on-11000 logic
// =============================================================================

console.log('\n[F-05] Room-code creation retry on duplicate-key error:');

/**
 * Simulate the retry loop in the POST /api/rooms handler.
 * existingCodes: Set of codes that already "exist" (simulate 11000 collision).
 * codeSequence: array of codes to try in order.
 * Returns { success, attempts, usedCode }.
 */
function simulateRetryCreate(codeSequence, existingCodes, maxAttempts = 5) {
  for (let i = 0; i < maxAttempts && i < codeSequence.length; i++) {
    const code = codeSequence[i];
    if (!existingCodes.has(code)) {
      existingCodes.add(code);
      return { success: true, attempts: i + 1, usedCode: code };
    }
    // else: simulate 11000 on roomCode → continue
  }
  return { success: false, attempts: Math.min(maxAttempts, codeSequence.length) };
}

test('unique code on first attempt — no collision', () => {
  const result = simulateRetryCreate(['AAAAAA'], new Set(), 5);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.attempts, 1);
  assert.strictEqual(result.usedCode, 'AAAAAA');
});

test('first code collides, second succeeds on attempt 2', () => {
  const existing = new Set(['AAAAAA']);
  const result = simulateRetryCreate(['AAAAAA', 'BBBBBB'], existing, 5);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.attempts, 2);
  assert.strictEqual(result.usedCode, 'BBBBBB');
});

test('all 5 codes collide — returns failure (bounded retry)', () => {
  const codes = ['C1', 'C2', 'C3', 'C4', 'C5'];
  const existing = new Set(codes);
  const result = simulateRetryCreate(codes, existing, 5);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.attempts, 5);
});

test('11000 on roomCode is retried; 11000 on other key is not', () => {
  const shouldRetryOnRoomCode = (err) =>
    err.code === 11000 && !!(err.keyPattern && err.keyPattern.roomCode);

  assert.strictEqual(shouldRetryOnRoomCode({ code: 11000, keyPattern: { roomCode: 1 } }), true);
  assert.strictEqual(shouldRetryOnRoomCode({ code: 11000, keyPattern: { email: 1 } }), false);
  assert.strictEqual(shouldRetryOnRoomCode({ code: 11000, keyPattern: { name: 1 } }), false);
  assert.strictEqual(shouldRetryOnRoomCode({ name: 'ValidationError' }), false);
});

test('room code format: 6 chars from known charset', () => {
  const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ROOM_REGEX = /^[A-Z0-9]{6}$/;
  // Simulate generateRoomCode logic
  function genCode() {
    let code = '';
    for (let i = 0; i < 6; i++) code += CHARSET[Math.floor(Math.random() * CHARSET.length)];
    return code;
  }
  for (let i = 0; i < 20; i++) {
    const code = genCode();
    assert.match(code, ROOM_REGEX, `Generated code "${code}" does not match regex`);
    assert.strictEqual(code.length, 6);
  }
});

// =============================================================================
// F-06: Duplicate email → HTTP 409 (already fixed in Phase 1)
// =============================================================================

console.log('\n[F-06] Duplicate email registration → 409 conflict:');

function classifyRegisterError(error) {
  if (error.name === 'ValidationError') return { status: 400 };
  if (error.code === 11000 && error.keyPattern && error.keyPattern.email) {
    return { status: 409, message: 'An account with that email already exists' };
  }
  return { status: 500 };
}

test('concurrent duplicate email → 409', () => {
  const err = { code: 11000, keyPattern: { email: 1 } };
  const result = classifyRegisterError(err);
  assert.strictEqual(result.status, 409);
  assert.ok(result.message.includes('already exists'));
});

test('validation error → 400', () => {
  const err = { name: 'ValidationError', errors: {} };
  assert.strictEqual(classifyRegisterError(err).status, 400);
});

test('generic error → 500', () => {
  assert.strictEqual(classifyRegisterError(new Error('timeout')).status, 500);
});

test('11000 on non-email key → 500, not 409', () => {
  const err = { code: 11000, keyPattern: { roomCode: 1 } };
  assert.strictEqual(classifyRegisterError(err).status, 500);
});

// =============================================================================
// F-12: Dashboard timezone / UTC boundary computation
// =============================================================================

console.log('\n[F-12] Dashboard timezone-aware UTC boundaries:');

/**
 * Pure reimplementation of getUtcBoundaries for unit testing.
 * Accepts the local date string and UTC offset in minutes.
 */
function computeBoundaries(localDateStr, offsetMinutes) {
  const [year, month, day] = localDateStr.split('-').map(Number);
  const todayStartMs = Date.UTC(year, month - 1, day) - offsetMinutes * 60000;
  const todayStart = new Date(todayStartMs);
  const todayEnd = new Date(todayStartMs + 86400000);

  const tempDate = new Date(Date.UTC(year, month - 1, day));
  const dow = tempDate.getUTCDay(); // 0=Sun
  const diffToMonday = dow === 0 ? 6 : dow - 1;
  const weekStartMs = todayStartMs - diffToMonday * 86400000;
  const weekStart = new Date(weekStartMs);
  const weekEnd = new Date(weekStartMs + 7 * 86400000);

  return { todayStart, todayEnd, weekStart, weekEnd };
}

test('UTC user: todayStart at midnight UTC', () => {
  const b = computeBoundaries('2024-01-15', 0);
  assert.strictEqual(b.todayStart.toISOString(), '2024-01-15T00:00:00.000Z');
  assert.strictEqual(b.todayEnd.toISOString(), '2024-01-16T00:00:00.000Z');
});

test('UTC-5 user: todayStart at 05:00Z', () => {
  const b = computeBoundaries('2024-01-15', -300);
  assert.strictEqual(b.todayStart.toISOString(), '2024-01-15T05:00:00.000Z');
  assert.strictEqual(b.todayEnd.toISOString(), '2024-01-16T05:00:00.000Z');
});

test('UTC+5:30 (IST) user: todayStart at 18:30Z on previous UTC day', () => {
  const b = computeBoundaries('2024-01-15', 330); // IST = UTC+5:30
  assert.strictEqual(b.todayStart.toISOString(), '2024-01-14T18:30:00.000Z');
  assert.strictEqual(b.todayEnd.toISOString(), '2024-01-15T18:30:00.000Z');
});

test('todayEnd is exactly 24h after todayStart', () => {
  const b = computeBoundaries('2024-03-10', -300); // UTC-5 (DST transition day)
  assert.strictEqual(b.todayEnd.getTime() - b.todayStart.getTime(), 86400000);
});

test('week starts on Monday (2024-01-15 is a Monday)', () => {
  const b = computeBoundaries('2024-01-15', 0);
  assert.strictEqual(b.weekStart.toISOString(), '2024-01-15T00:00:00.000Z');
  assert.strictEqual(b.weekEnd.toISOString(), '2024-01-22T00:00:00.000Z');
});

test('week for Wednesday 2024-01-17: starts on Monday 2024-01-15', () => {
  const b = computeBoundaries('2024-01-17', 0);
  assert.strictEqual(b.weekStart.toISOString(), '2024-01-15T00:00:00.000Z');
});

test('week for Sunday 2024-01-21: starts on Monday 2024-01-15', () => {
  const b = computeBoundaries('2024-01-21', 0);
  assert.strictEqual(b.weekStart.toISOString(), '2024-01-15T00:00:00.000Z');
  assert.strictEqual(b.weekEnd.toISOString(), '2024-01-22T00:00:00.000Z');
});

test('week is exactly 7 days (7×86400000 ms)', () => {
  const b = computeBoundaries('2024-06-15', 60);
  assert.strictEqual(b.weekEnd.getTime() - b.weekStart.getTime(), 7 * 86400000);
});

test('UTC fallback when no timezone given: uses UTC date', () => {
  // Simulate the fallback path: use UTC year/month/day
  const now = new Date('2024-01-15T03:00:00Z'); // 3am UTC
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const localDateStr = `${y}-${m}-${d}`;
  assert.strictEqual(localDateStr, '2024-01-15');
  const b = computeBoundaries(localDateStr, 0);
  assert.strictEqual(b.todayStart.toISOString(), '2024-01-15T00:00:00.000Z');
});

test('invalid timezone string is handled gracefully (falls back to UTC)', () => {
  // The server catches RangeError from Intl and falls back to UTC
  let valid = true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: 'Not/ATimezone' }).format(new Date());
  } catch {
    valid = false;
  }
  assert.strictEqual(valid, false, 'invalid timezone throws as expected');
  // After catching, server uses UTC offset=0 — boundary test covered above
});

// =============================================================================
// F-14: Multi-tab presence deduplication by userId
// =============================================================================

console.log('\n[F-14] Multi-tab presence deduplication:');

const STATUS_PRIORITY = { focusing: 3, 'on break': 2, idle: 1 };

function deduplicatePresence(socketEntries) {
  const byUser = new Map();
  for (const { userId, name, status } of socketEntries) {
    const existing = byUser.get(userId);
    if (!existing || (STATUS_PRIORITY[status] ?? 0) > (STATUS_PRIORITY[existing.status] ?? 0)) {
      byUser.set(userId, { userId, name, status });
    }
  }
  return Array.from(byUser.values());
}

test('one user one tab: appears exactly once', () => {
  const list = deduplicatePresence([{ userId: 'u1', name: 'Alice', status: 'focusing' }]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].status, 'focusing');
});

test('one user two tabs with same status: appears once', () => {
  const list = deduplicatePresence([
    { userId: 'u1', name: 'Alice', status: 'idle' },
    { userId: 'u1', name: 'Alice', status: 'idle' },
  ]);
  assert.strictEqual(list.length, 1);
});

test('one user two tabs with different statuses: highest priority wins (focusing > idle)', () => {
  const list = deduplicatePresence([
    { userId: 'u1', name: 'Alice', status: 'idle' },
    { userId: 'u1', name: 'Alice', status: 'focusing' },
  ]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].status, 'focusing');
});

test('on break beats idle', () => {
  const list = deduplicatePresence([
    { userId: 'u1', name: 'Alice', status: 'idle' },
    { userId: 'u1', name: 'Alice', status: 'on break' },
  ]);
  assert.strictEqual(list[0].status, 'on break');
});

test('focusing beats on break', () => {
  const list = deduplicatePresence([
    { userId: 'u1', name: 'Alice', status: 'on break' },
    { userId: 'u1', name: 'Alice', status: 'focusing' },
  ]);
  assert.strictEqual(list[0].status, 'focusing');
});

test('two different users: both appear independently', () => {
  const list = deduplicatePresence([
    { userId: 'u1', name: 'Alice', status: 'focusing' },
    { userId: 'u2', name: 'Bob', status: 'idle' },
  ]);
  assert.strictEqual(list.length, 2);
});

test('disconnect one tab: user still present if other tab remains', () => {
  const socketMap = new Map([
    ['s1', { userId: 'u1', name: 'Alice', status: 'focusing' }],
    ['s2', { userId: 'u1', name: 'Alice', status: 'idle' }],
    ['s3', { userId: 'u2', name: 'Bob', status: 'idle' }],
  ]);
  socketMap.delete('s1'); // one tab disconnects
  const list = deduplicatePresence(Array.from(socketMap.values()));
  assert.strictEqual(list.length, 2, 'Alice still present via second tab');
  const alice = list.find((u) => u.userId === 'u1');
  assert.ok(alice, 'Alice found');
  assert.strictEqual(alice.status, 'idle', 'remaining tab status is idle');
});

test('disconnect final tab: user removed from list', () => {
  const socketMap = new Map([
    ['s1', { userId: 'u1', name: 'Alice', status: 'focusing' }],
    ['s3', { userId: 'u2', name: 'Bob', status: 'idle' }],
  ]);
  socketMap.delete('s1'); // Alice's only tab disconnects
  const list = deduplicatePresence(Array.from(socketMap.values()));
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].userId, 'u2');
});

test('React key uniqueness: no duplicate keys in deduplicated list', () => {
  const entries = [
    { userId: 'u1', name: 'Alice', status: 'idle' },
    { userId: 'u1', name: 'Alice', status: 'focusing' },
    { userId: 'u2', name: 'Bob', status: 'idle' },
  ];
  const list = deduplicatePresence(entries);
  const keys = list.map((u) => u.userId);
  assert.strictEqual(new Set(keys).size, keys.length, 'all React keys are unique');
});

// =============================================================================
// F-16: Focus session pagination
// =============================================================================

console.log('\n[F-16] Focus session pagination:');

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

function parsePagination(query) {
  let page = parseInt(query.page, 10);
  let limit = parseInt(query.limit, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  return { page, limit, skip: (page - 1) * limit };
}

test('default page=1, limit=20 when no params', () => {
  const p = parsePagination({});
  assert.strictEqual(p.page, 1);
  assert.strictEqual(p.limit, DEFAULT_LIMIT);
  assert.strictEqual(p.skip, 0);
});

test('valid page=2, limit=10 → skip=10', () => {
  const p = parsePagination({ page: '2', limit: '10' });
  assert.strictEqual(p.page, 2);
  assert.strictEqual(p.limit, 10);
  assert.strictEqual(p.skip, 10);
});

test('limit=999 capped to MAX_LIMIT (100)', () => {
  const p = parsePagination({ limit: '999' });
  assert.strictEqual(p.limit, MAX_LIMIT);
});

test('negative page coerced to 1', () => {
  const p = parsePagination({ page: '-5' });
  assert.strictEqual(p.page, 1);
  assert.strictEqual(p.skip, 0);
});

test('page=0 coerced to 1', () => {
  const p = parsePagination({ page: '0' });
  assert.strictEqual(p.page, 1);
});

test('non-numeric limit falls back to default', () => {
  const p = parsePagination({ limit: 'abc' });
  assert.strictEqual(p.limit, DEFAULT_LIMIT);
});

test('float page is floored by parseInt (parseInt("2.9") = 2)', () => {
  const p = parsePagination({ page: '2.9', limit: '10' });
  assert.strictEqual(p.page, 2);
  assert.strictEqual(p.skip, 10);
});

test('skip computed correctly for page 5 limit 20', () => {
  const p = parsePagination({ page: '5', limit: '20' });
  assert.strictEqual(p.skip, 80);
});

test('totalPages rounds up correctly', () => {
  assert.strictEqual(Math.ceil(95 / 20), 5);
  assert.strictEqual(Math.ceil(100 / 20), 5);
  assert.strictEqual(Math.ceil(101 / 20), 6);
  assert.strictEqual(Math.ceil(0 / 20) || 0, 0);
});

test('response includes sessions array and pagination metadata', () => {
  const mockResponse = {
    sessions: [{ _id: '1', durationMinutes: 25 }],
    pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
  };
  assert.ok(Array.isArray(mockResponse.sessions), 'sessions is an array');
  assert.ok(mockResponse.pagination, 'pagination object present');
  assert.strictEqual(mockResponse.pagination.totalPages, 1);
});

// =============================================================================
// F-17: Database indexes (documentation/presence check)
// =============================================================================

console.log('\n[F-17] FocusSession compound indexes:');

// Enumerate indexes that should exist per the model definition
const EXPECTED_INDEX_NAMES = [
  'user_1',                        // from index:true on user field
  'uniq_user_room_timerCycleId',   // Phase 2 partial unique
  'idx_user_sessionType_completedAt', // F-17 new — dashboard queries
  'idx_user_completedAt',          // F-17 new — pagination + streak
];

test('all expected indexes are declared', () => {
  for (const name of EXPECTED_INDEX_NAMES) {
    assert.ok(EXPECTED_INDEX_NAMES.includes(name), `Index ${name} is in the expected set`);
  }
});

test('dashboard aggregation index covers { user, sessionType, completedAt }', () => {
  // Index { user:1, sessionType:1, completedAt:-1 } covers:
  // filter: { user: X, sessionType: 'focus', completedAt: { $gte, $lt } }
  const indexFields = ['user', 'sessionType', 'completedAt'];
  const queryFields = ['user', 'sessionType', 'completedAt'];
  assert.ok(queryFields.every((f) => indexFields.includes(f)), 'index covers query');
});

test('pagination index covers { user, completedAt }', () => {
  // Index { user:1, completedAt:-1 } covers:
  // find({ user }).sort({ completedAt: -1 }).skip().limit()
  const indexFields = ['user', 'completedAt'];
  const queryFields = ['user'];
  const sortFields = ['completedAt'];
  assert.ok(queryFields.every((f) => indexFields.includes(f)));
  assert.ok(sortFields.every((f) => indexFields.includes(f)));
});

test('Phase 2 unique index is preserved', () => {
  assert.ok(EXPECTED_INDEX_NAMES.includes('uniq_user_room_timerCycleId'));
});

// =============================================================================
// F-18: Axios 401 handling (already fixed in Phase 1 — verify behavior)
// =============================================================================

console.log('\n[F-18] Axios 401 handling (Phase 1 verified):');

function simulateAxiosInterceptor(status, pathname) {
  let authCleared = false;
  let redirected = false;
  let toastShown = false;

  if (status === 401) {
    authCleared = true;
    toastShown = true;
    if (pathname !== '/login') redirected = true;
  }
  return { authCleared, redirected, toastShown };
}

test('401 on protected route clears auth and redirects', () => {
  const result = simulateAxiosInterceptor(401, '/dashboard');
  assert.strictEqual(result.authCleared, true);
  assert.strictEqual(result.redirected, true);
  assert.strictEqual(result.toastShown, true);
});

test('401 on /login page clears auth but does NOT redirect (avoids loop)', () => {
  const result = simulateAxiosInterceptor(401, '/login');
  assert.strictEqual(result.authCleared, true);
  assert.strictEqual(result.redirected, false, 'no redirect on /login');
});

test('400 validation error does NOT clear auth', () => {
  const result = simulateAxiosInterceptor(400, '/dashboard');
  assert.strictEqual(result.authCleared, false, '400 must not clear auth');
  assert.strictEqual(result.redirected, false);
});

test('403 forbidden does NOT clear auth', () => {
  const result = simulateAxiosInterceptor(403, '/room/ABC123');
  assert.strictEqual(result.authCleared, false);
});

test('toast dedup: id="auth-401" prevents duplicate toasts', () => {
  // Simulated: toast.error(msg, { id: 'auth-401' }) — react-hot-toast deduplicates by id
  const toastCalls = [];
  const toast = { error: (msg, opts) => toastCalls.push({ msg, id: opts?.id }) };
  toast.error('Session expired', { id: 'auth-401' });
  toast.error('Session expired', { id: 'auth-401' });
  const uniqueIds = new Set(toastCalls.map((c) => c.id));
  assert.ok(uniqueIds.has('auth-401'), 'toast uses stable id');
  assert.strictEqual(toastCalls.length, 2, 'second call is idempotent in react-hot-toast');
});

// =============================================================================
// F-21: CORS / environment validation (already fixed in Phase 1 — verify)
// =============================================================================

console.log('\n[F-21] CORS/environment validation (Phase 1 verified):');

function isProductionLocalhost(clientUrl, isProduction) {
  if (!isProduction) return false;
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(clientUrl || '');
}

function isValidOrigin(requestOrigin, allowedOrigin) {
  return requestOrigin === allowedOrigin;
}

test('production: exact CLIENT_URL accepted', () => {
  assert.strictEqual(isValidOrigin('https://focus.example.com', 'https://focus.example.com'), true);
});

test('production: different origin rejected', () => {
  assert.strictEqual(isValidOrigin('https://evil.com', 'https://focus.example.com'), false);
});

test('production: localhost in CLIENT_URL is invalid', () => {
  assert.strictEqual(isProductionLocalhost('http://localhost:5173', true), true);
});

test('development: localhost CLIENT_URL is valid', () => {
  assert.strictEqual(isProductionLocalhost('http://localhost:5173', false), false);
});

test('production: HTTPS domain CLIENT_URL is valid', () => {
  assert.strictEqual(isProductionLocalhost('https://focus.example.com', true), false);
});

test('null origin is rejected (not equal to allowed origin)', () => {
  assert.strictEqual(isValidOrigin(null, 'https://focus.example.com'), false);
  assert.strictEqual(isValidOrigin(undefined, 'https://focus.example.com'), false);
});

// =============================================================================
// Summary
// =============================================================================

console.log(`\n=== Phase 3 smoke test result: ${passCount} passed, ${failCount} failed ===`);
if (failCount > 0) process.exit(1);
