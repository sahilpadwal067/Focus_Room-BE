/**
 * Focused Phase 1 smoke tests — no DB, no network, pure logic checks.
 * Run: node server/tests/phase1.smoke.js
 * Failing tests exit with code 1.
 */

const assert = require('assert');
const crypto = require('crypto');

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

// ================================================================
// 1. Placeholder detection (F-01 env validation)
// ================================================================

console.log('\n[F-01] Placeholder detection:');

const PLACEHOLDER_SECRET_PATTERNS = [
  /replace_/i,
  /replace-/i,
  /replace with/i,
  /changeme/i,
  /your_/i,
  /<username>/i,
  /<password>/i,
  /xxxxx/,
  /^example$/i,
  /^test$/i,
  /changethis/i,
  /default_?secret/i,
  /foo|bar|baz|qux/i,
];

function isPlaceholder(value) {
  if (!value || typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (trimmed.length < 8) return true;
  return PLACEHOLDER_SECRET_PATTERNS.some((re) => re.test(trimmed));
}

test('placeholder: empty string flagged', () => { assert.strictEqual(isPlaceholder(''), true); });
test('placeholder: short string flagged', () => { assert.strictEqual(isPlaceholder('short'), true); });
test('placeholder: null flagged', () => { assert.strictEqual(isPlaceholder(null), true); });
test('placeholder: <password> example flagged', () => { assert.strictEqual(isPlaceholder('mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/focus-room'), true); });
test('placeholder: replace_with flagged', () => { assert.strictEqual(isPlaceholder('replace_with_a_long_random_secret_string_here'), true); });
test('placeholder: real 64-hex JWT secret NOT flagged', () => {
  const real = crypto.randomBytes(32).toString('hex');
  assert.strictEqual(isPlaceholder(real), false);
});
test('placeholder: plausible Mongo Atlas URI NOT flagged', () => {
  const plausible = 'mongodb+srv://appuser:REDACTED_PASSWORD@cluster0.example.invalid/focus-room?retryWrites=true&w=majority';
  assert.strictEqual(isPlaceholder(plausible), false);
});

// ================================================================
// 2. Room code normalization + regex (F-02, F-13)
// ================================================================

console.log('\n[F-02/F-13] Room code validation:');

const ROOM_CODE_REGEX = /^[A-Z0-9]{6}$/;
function normalizeRoomCode(rawCode) {
  if (rawCode === null || rawCode === undefined) return null;
  if (typeof rawCode !== 'string') return null;
  const code = rawCode.trim().toUpperCase();
  if (!ROOM_CODE_REGEX.test(code)) return null;
  return code;
}

test('roomCode: valid lower→upper', () => { assert.strictEqual(normalizeRoomCode('abc123'), 'ABC123'); });
test('roomCode: valid padded whitespace', () => { assert.strictEqual(normalizeRoomCode('  AB12CD  '), 'AB12CD'); });
test('roomCode: invalid chars (O/0 I/1) returns null', () => { assert.strictEqual(normalizeRoomCode('ABCDO!'), null); });
test('roomCode: short code returns null', () => { assert.strictEqual(normalizeRoomCode('AB12'), null); });
test('roomCode: long code returns null', () => { assert.strictEqual(normalizeRoomCode('ABC1234'), null); });
test('roomCode: number payload returns null (not .trim() crash)', () => { assert.strictEqual(normalizeRoomCode(123456), null); });
test('roomCode: object payload returns null (not .trim() crash)', () => { assert.strictEqual(normalizeRoomCode({ code: 'ABC123' }), null); });
test('roomCode: array payload returns null', () => { assert.strictEqual(normalizeRoomCode(['ABC123']), null); });
test('roomCode: null returns null', () => { assert.strictEqual(normalizeRoomCode(null), null); });
test('roomCode: undefined returns null', () => { assert.strictEqual(normalizeRoomCode(undefined), null); });
test('roomCode: empty string returns null', () => { assert.strictEqual(normalizeRoomCode(''), null); });

// ================================================================
// 3. Room membership check (F-02, F-11)
// ================================================================

console.log('\n[F-02/F-11] Room membership + socket authorization:');

function isRoomMember(user, room) {
  if (!user || !room) return false;
  const uid = String(user._id || user);
  if (String(room.createdBy?._id || room.createdBy) === uid) return true;
  if (Array.isArray(room.members)) {
    for (const m of room.members) {
      if (String(m._id || m) === uid) return true;
    }
  }
  return false;
}

const uidA = new ObjectIdMock('aaaaaaaaaaaaaaaaaaaaaaaa');
const uidB = new ObjectIdMock('bbbbbbbbbbbbbbbbbbbbbbbb');
const uidC = new ObjectIdMock('cccccccccccccccccccccccc');
function ObjectIdMock(v) { this._s = v; this.toString = () => v; }

const roomA = {
  createdBy: uidA,
  members: [uidB],
  roomCode: 'ABC123',
};
test('isRoomMember: creator is member', () => { assert.strictEqual(isRoomMember(uidA, roomA), true); });
test('isRoomMember: added member is member', () => { assert.strictEqual(isRoomMember(uidB, roomA), true); });
test('isRoomMember: non member NOT member', () => { assert.strictEqual(isRoomMember(uidC, roomA), false); });
test('isRoomMember: user with plain string id matches', () => {
  const user = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa' };
  assert.strictEqual(isRoomMember(user, roomA), true);
});
test('isRoomMember: null user → false', () => { assert.strictEqual(isRoomMember(null, roomA), false); });

// AuthorizeSocketForRoomAction — simulates combined check: socketRoomSet.has + currentRoomCode match + isRoomMember
function authorizeSocketAction({ socket, room, currentRoomCode }) {
  if (!room?.roomCode) return false;
  if (!currentRoomCode || currentRoomCode !== room.roomCode) return false;
  if (!socket.rooms.has(room.roomCode)) return false;
  if (!isRoomMember(socket.user, room)) return false;
  return true;
}

// Legitimate user B (joined room, member, socket in io room)
const legitSocket = { rooms: new Set(['ABC123']), user: uidB };
test('authorized: joined member B → allowed', () => {
  assert.strictEqual(authorizeSocketAction({ socket: legitSocket, room: roomA, currentRoomCode: 'ABC123' }), true);
});
// IDOR attacker: user C currently connected in his own room XYZ789, tries timer-start via code guess ABC123
const attackerSocket = { rooms: new Set(['XYZ789']), user: uidC };
test('IDOR attack: attacker in different socket room → rejected', () => {
  assert.strictEqual(authorizeSocketAction({ socket: attackerSocket, room: roomA, currentRoomCode: 'XYZ789' }), false);
});
// Attacker not in any socket room
const notJoinedSocket = { rooms: new Set(), user: uidB };
test('joined not complete (socket.io leave-room in progress) → rejected', () => {
  assert.strictEqual(authorizeSocketAction({ socket: notJoinedSocket, room: roomA, currentRoomCode: 'ABC123' }), false);
});
// currentRoomCode stale (user was in room but just left but still in socket room due to race)
const staleCurrentRoomSocket = { rooms: new Set(['ABC123']), user: uidB };
test('currentRoomCode mismatch with actual room → rejected', () => {
  assert.strictEqual(authorizeSocketAction({ socket: staleCurrentRoomSocket, room: roomA, currentRoomCode: 'OTHER1' }), false);
});

// ================================================================
// 4. Token version revocation check (F-10)
// ================================================================

console.log('\n[F-10] TokenVersion revocation:');

function isTokenRevoked(tokenVersionInJwt, tokenVersionOnUser) {
  const token = Number(tokenVersionInJwt) || 0;
  const user = Number(tokenVersionOnUser) || 0;
  return token !== user;
}

test('revocation: fresh login 0/0 → not revoked', () => { assert.strictEqual(isTokenRevoked(0, 0), false); });
test('revocation: user logged out (0/1) → revoked', () => { assert.strictEqual(isTokenRevoked(0, 1), true); });
test('revocation: user password changed twice (1/3) → revoked', () => { assert.strictEqual(isTokenRevoked(1, 3), true); });
test('revocation: string jti coerced → revoked', () => { assert.strictEqual(isTokenRevoked('0', '1'), true); });
test('revocation: null user version → defaults to 0', () => { assert.strictEqual(isTokenRevoked(null, 0), false); });
test('revocation: null token + user bumped → revoked', () => { assert.strictEqual(isTokenRevoked(null, 1), true); });

// ================================================================
// 5. Presence status enum validation (F-13 malformed input guard)
// ================================================================

console.log('\n[F-13] Presence status + room-code sanitized:');

const ALLOWED_PRESENCE_STATUSES = ['focusing', 'on break', 'idle'];

function sanitizeStatus(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!ALLOWED_PRESENCE_STATUSES.includes(v)) return null;
  return v;
}

test('status: focusing allowed', () => { assert.strictEqual(sanitizeStatus('focusing'), 'focusing'); });
test('status: on break allowed', () => { assert.strictEqual(sanitizeStatus('on break'), 'on break'); });
test('status: idle allowed', () => { assert.strictEqual(sanitizeStatus('idle'), 'idle'); });
test('status: random string rejected', () => { assert.strictEqual(sanitizeStatus('hacked'), null); });
test('status: number rejected', () => { assert.strictEqual(sanitizeStatus(123), null); });
test('status: object rejected', () => { assert.strictEqual(sanitizeStatus({ x: 1 }), null); });
test('status: empty string rejected', () => { assert.strictEqual(sanitizeStatus(''), null); });

// ================================================================
// 6. Socket rate limiting counter logic (F-09 socket events)
// ================================================================

console.log('\n[F-09] Socket in-memory rate limiter:');

const SOCKET_EVENT_RATE_LIMIT = 5; // small for test
const SOCKET_RATE_WINDOW_MS = 60_000;
const socketRateMap = new Map();
function checkSocketRate(socketId, now = Date.now()) {
  let entry = socketRateMap.get(socketId);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + SOCKET_RATE_WINDOW_MS };
    socketRateMap.set(socketId, entry);
  }
  entry.count += 1;
  return entry.count <= SOCKET_EVENT_RATE_LIMIT;
}

test('rate limit: first 5 events allowed', () => {
  for (let i = 0; i < 5; i += 1) {
    assert.strictEqual(checkSocketRate('socket-abc', 1000), true, `iteration ${i}`);
  }
});
test('rate limit: 6th event rejected', () => {
  assert.strictEqual(checkSocketRate('socket-abc', 1000), false);
});
test('rate limit: new window after reset → allowed again', () => {
  assert.strictEqual(checkSocketRate('socket-abc', 1000 + 60_001), true);
});
socketRateMap.clear();

// ================================================================
// Summary
// ================================================================

console.log(`\n=== Smoke test result: ${passCount} passed, ${failCount} failed ===`);
if (failCount > 0) process.exit(1);
