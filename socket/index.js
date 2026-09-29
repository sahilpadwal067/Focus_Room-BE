/**
 * Socket.io handler Phase 4 (timer) + Phase 5 (presence).
 *
 *  Timer events received 
 *   join-room      { roomCode }
 *   leave-room     { roomCode }
 *   timer-start    { roomCode }
 *   timer-pause    { roomCode }
 *   timer-resume   { roomCode }
 *   timer-reset    { roomCode }
 *
 *  Presence events received 
 *   presence-status { roomCode, status }    client reports its own status
 *
 *  Events emitted 
 *   timer-state      <TimerStatePayload>   broadcast to room
 *   room-error       { message }           to offending socket only
 *   presence-update  { users: [...] }      broadcast to room on any change
 */

const socketAuth = require('../middleware/socketAuth');
const Room = require('../models/Room');
const { buildTimerState, uniqueUserIds, shouldFinalizeTimer, computeRemainingMs } = require('../utils/timerHelper');
const {
  addParticipant,
  persistStart,
  persistPause,
  persistResume,
  persistComplete,
  persistReset,
  recordFocusSessions,
  backfillRunningEndsAt,
} = require('../utils/timerStore');

const { ROOM_CODE_REGEX } = require('../utils/roomCode');
const ALLOWED_PRESENCE_STATUSES = ['focusing', 'on break', 'idle'];
const SOCKET_EVENT_RATE_LIMIT = 120; // max events per socket per 60-second window
const SOCKET_RATE_WINDOW_MS = 60_000;

// In-memory presence store 
// Map<roomCode, Map<socketId, { userId, name, status }>>
const presenceMap = new Map();
// Socket event rate limiter: Map<socketId, { count, resetAt }>
const socketRateMap = new Map();

function getRoom(roomCode) {
  if (!presenceMap.has(roomCode)) presenceMap.set(roomCode, new Map());
  return presenceMap.get(roomCode);
}

function addUser(roomCode, socketId, userId, name, status = 'idle') {
  getRoom(roomCode).set(socketId, { userId: String(userId), name, status });
}

function removeUser(roomCode, socketId) {
  const room = presenceMap.get(roomCode);
  if (room) {
    room.delete(socketId);
    if (room.size === 0) presenceMap.delete(roomCode);
  }
}

function updateStatus(roomCode, socketId, status) {
  const room = presenceMap.get(roomCode);
  if (room && room.has(socketId)) {
    room.get(socketId).status = status;
  }
}

/**
 * Status priority for multi-tab deduplication (F-14).
 * When a user has multiple sockets in the room, display the highest-priority status.
 * focusing > on break > idle
 */
const STATUS_PRIORITY = { focusing: 3, 'on break': 2, idle: 1 };

/**
 * Build the deduplicated presence array sent to clients — one entry per unique userId.
 * When the same user has multiple tabs open (multiple socketIds), we aggregate them into
 * one entry using the highest-priority status so the user does not appear multiple times.
 * Different users always appear independently.
 */
function presenceList(roomCode) {
  const room = presenceMap.get(roomCode);
  if (!room) return [];
  // Aggregate by userId: keep the entry with the highest-priority status.
  const byUser = new Map();
  for (const { userId, name, status } of room.values()) {
    const existing = byUser.get(userId);
    if (!existing || (STATUS_PRIORITY[status] ?? 0) > (STATUS_PRIORITY[existing.status] ?? 0)) {
      byUser.set(userId, { userId, name, status });
    }
  }
  return Array.from(byUser.values());
}

function broadcastPresence(io, roomCode) {
  io.to(roomCode).emit('presence-update', { users: presenceList(roomCode) });
}

//  Timer in-memory completion timers
const completionTimers = new Map();

// Helpers 

const emitError = (socket, message) => socket.emit('room-error', { message });

/**
 * Validate and normalize a roomCode from an untrusted payload.
 * Returns the uppercase code if valid; returns null (and optionally emits
 * a safe error) if the payload is malformed. Never throws.
 */
function normalizeRoomCode(rawCode, socketForError) {
  if (rawCode === null || rawCode === undefined) {
    if (socketForError) emitError(socketForError, 'Room code required');
    return null;
  }
  if (typeof rawCode !== 'string') {
    if (socketForError) emitError(socketForError, 'Room code required');
    return null;
  }
  const code = rawCode.trim().toUpperCase();
  if (!ROOM_CODE_REGEX.test(code)) {
    if (socketForError) emitError(socketForError, 'Invalid room code');
    return null;
  }
  return code;
}

/** Return true if the user is the creator OR a stored member of the room */
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

async function loadRoom(socket, roomCode, options = {}) {
  const code = normalizeRoomCode(roomCode, socket);
  if (!code) return null;
  let room;
  try {
    room = await Room.findOne({ roomCode: code });
  } catch (err) {
    console.error('loadRoom db error:', err.message);
    emitError(socket, 'Room not found');
    return null;
  }
  if (!room) {
    emitError(socket, 'Room not found');
    return null;
  }
  if (options.requireMember && socket.user && !isRoomMember(socket.user, room)) {
    emitError(socket, 'Not authorised to access this room');
    return null;
  }
  return room;
}

/**
 * Per-socket event rate limiter (best-effort, in-memory).
 * Returns true if the request is allowed, false if rate limited.
 */
function checkSocketRate(socket, eventName) {
  const now = Date.now();
  let entry = socketRateMap.get(socket.id);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + SOCKET_RATE_WINDOW_MS };
    socketRateMap.set(socket.id, entry);
  }
  entry.count += 1;
  if (entry.count > SOCKET_EVENT_RATE_LIMIT) {
    console.warn(`Socket ${socket.id} exceeded event rate on ${eventName}`);
    emitError(socket, 'Too many requests, please slow down');
    return false;
  }
  return true;
}

/** Clean up the socket rate map entry on socket disconnect */
function cleanupSocketRate(socketId) {
  socketRateMap.delete(socketId);
}

function emitTimerState(io, room) {
  io.to(room.roomCode).emit('timer-state', buildTimerState(room));
}

function presentUserIds(roomCode) {
  return uniqueUserIds(presenceList(roomCode));
}

function scheduleCompletion(io, room) {
  clearCompletion(room.roomCode);
  const remaining = computeRemainingMs(room);
  if (remaining === 0) return handleCompletion(io, room.roomCode);
  const timeout = setTimeout(() => handleCompletion(io, room.roomCode), remaining);
  completionTimers.set(room.roomCode, timeout);
}

function clearCompletion(roomCode) {
  const t = completionTimers.get(roomCode);
  if (t) { clearTimeout(t); completionTimers.delete(roomCode); }
}

async function handleCompletion(io, roomCode) {
  completionTimers.delete(roomCode);
  try {
    const now = Date.now();
    const { room } = await persistComplete(roomCode, now);
    if (!room) return;

    try {
      const result = await recordFocusSessions(room, room.timerAccumulatedMs, new Date(now));
      if (result.recorded > 0) {
        console.log(` Recorded ${result.recorded} focus session(s) for room ${roomCode}`);
      }
    } catch (dbErr) {
      console.error(`FocusSession save error in ${roomCode}:`, dbErr.message);
    }

    emitTimerState(io, room);
    console.log(` Timer completed in room ${roomCode}`);
  } catch (err) {
    console.error(`Completion handler error for ${roomCode}:`, err.message);
  }
}

async function restoreTimers(io) {
  const now = Date.now();
  let running = [];
  let unrecorded = [];
  try {
    running = await Room.find({ timerStatus: 'running' });
    unrecorded = await Room.find({
      timerStatus: 'completed',
      timerSessionsRecorded: false,
    });
  } catch (err) {
    console.error('restoreTimers query error:', err.message);
    return;
  }

  for (const room of running) {
    try {
      const hydrated = await backfillRunningEndsAt(room, now);
      if (shouldFinalizeTimer(hydrated, now)) {
        await handleCompletion(io, hydrated.roomCode);
      } else {
        scheduleCompletion(io, hydrated);
      }
    } catch (err) {
      console.error(`restoreTimers running ${room.roomCode}:`, err.message);
    }
  }

  for (const room of unrecorded) {
    try {
      await recordFocusSessions(room, room.timerAccumulatedMs, room.updatedAt || new Date());
    } catch (err) {
      console.error(`restoreTimers unrecorded ${room.roomCode}:`, err.message);
    }
  }
}

function startTimerSweeper(io) {
  if (startTimerSweeper._started) return;
  startTimerSweeper._started = true;
  const handle = setInterval(async () => {
    try {
      const now = Date.now();
      const overdue = await Room.find({
        timerStatus: 'running',
        timerEndsAt: { $lte: now },
      }).select('roomCode');
      for (const room of overdue) {
        await handleCompletion(io, room.roomCode);
      }
    } catch (err) {
      console.error('timer sweeper error:', err.message);
    }
  }, 5000);
  if (typeof handle.unref === 'function') handle.unref();
}

// Main init

/**
 * Authorize a socket for timer actions on a room:
 *  (a) the socket's currentRoomCode (via join-room socket membership) matches
 *  (b) the socket.user is in the Room.members array OR is the creator
 * Returns true if authorized; emits error and returns false otherwise.
 */
function authorizeSocketForRoomAction(socket, room, currentRoomCode, action) {
  const normalized = normalizeRoomCode(room?.roomCode);
  if (!normalized) {
    emitError(socket, 'Invalid room');
    return false;
  }
  if (!currentRoomCode || currentRoomCode !== normalized) {
    emitError(socket, `Not authorised to ${action} this room`);
    return false;
  }
  if (!socket.rooms.has(normalized)) {
    emitError(socket, `Not authorised to ${action} this room`);
    return false;
  }
  if (!isRoomMember(socket.user, room)) {
    emitError(socket, `Not authorised to ${action} this room`);
    return false;
  }
  return true;
}

const initSocket = (io) => {
  io.use(socketAuth);

  io.on('connection', (socket) => {
    const user = socket.user;
    const userName = user?.name || 'Unknown';
    console.log(` Socket connected: ${socket.id} (${userName})`);

    // Track which room this socket is currently in (for disconnect cleanup)
    let currentRoomCode = null;

    //  join-room
    socket.on('join-room', async ({ roomCode } = {}) => {
      if (!checkSocketRate(socket, 'join-room')) return;
      try {
        const room = await loadRoom(socket, roomCode);
        if (!room) return;

        // If already in a different room, leave it first
        if (currentRoomCode && currentRoomCode !== room.roomCode) {
          await socket.leave(currentRoomCode);
          removeUser(currentRoomCode, socket.id);
          broadcastPresence(io, currentRoomCode);
        }

        // Ensure this socket user is recorded as a room member (shareable code grant)
        if (!isRoomMember(user, room)) {
          try {
            await Room.findByIdAndUpdate(
              room._id,
              { $addToSet: { members: user._id } },
              { runValidators: true }
            );
            room.members = Array.isArray(room.members) ? room.members.slice() : [];
            if (!room.members.some((m) => String(m) === String(user._id))) {
              room.members.push(user._id);
            }
          } catch (updateErr) {
            console.error('join-room member-add error:', updateErr.message);
            emitError(socket, 'Failed to join room');
            return;
          }
        }

        await socket.join(room.roomCode);
        currentRoomCode = room.roomCode;
        console.log(` ${userName} joined room ${room.roomCode}`);

        // Add to presence  default status 'idle'
        addUser(room.roomCode, socket.id, user._id, userName, 'idle');
        broadcastPresence(io, room.roomCode);

        await addParticipant(room._id, user._id);
        const latest = await Room.findById(room._id);
        const timerRoom = latest || room;
        socket.emit('timer-state', buildTimerState(timerRoom));

        if (timerRoom.timerStatus === 'running' && timerRoom.timerStartedAt) {
          if (shouldFinalizeTimer(timerRoom)) {
            await handleCompletion(io, timerRoom.roomCode);
          } else if (!completionTimers.has(timerRoom.roomCode)) {
            scheduleCompletion(io, timerRoom);
          }
        }
      } catch (err) {
        console.error('join-room error:', err.message);
        emitError(socket, 'Failed to join room');
      }
    });

    //  leave-room
    socket.on('leave-room', async ({ roomCode } = {}) => {
      if (!checkSocketRate(socket, 'leave-room')) return;
      try {
        const code = normalizeRoomCode(roomCode, socket);
        if (!code) return;
        await socket.leave(code);
        removeUser(code, socket.id);
        if (currentRoomCode === code) currentRoomCode = null;
        broadcastPresence(io, code);
        console.log(` ${userName} left room ${code}`);
      } catch (err) {
        console.error('leave-room error:', err.message);
        emitError(socket, 'Failed to leave room');
      }
    });

    //  presence-status 
    socket.on('presence-status', async ({ roomCode, status } = {}) => {
      if (!checkSocketRate(socket, 'presence-status')) return;
      try {
        const code = normalizeRoomCode(roomCode, socket);
        if (!code) return;
        if (typeof status !== 'string') {
          emitError(socket, 'Invalid status');
          return;
        }
        const trimmedStatus = status.trim();
        // Only allow update if this socket is actually in the room
        if (!currentRoomCode || currentRoomCode !== code) return;
        if (!socket.rooms.has(code)) return;
        if (!ALLOWED_PRESENCE_STATUSES.includes(trimmedStatus)) {
          emitError(socket, 'Invalid status');
          return;
        }
        updateStatus(code, socket.id, trimmedStatus);
        broadcastPresence(io, code);
      } catch (err) {
        console.error('presence-status error:', err.message);
        emitError(socket, 'Failed to update status');
      }
    });

    //  timer-start 
    socket.on('timer-start', async ({ roomCode, sessionType, durationMinutes } = {}) => {
      if (!checkSocketRate(socket, 'timer-start')) return;
      try {
        const room = await loadRoom(socket, roomCode, { requireMember: true });
        if (!room) return;
        if (!authorizeSocketForRoomAction(socket, room, currentRoomCode, 'start')) return;

        const now = Date.now();
        const validSessionType = ['focus', 'short_break', 'long_break'].includes(sessionType)
          ? sessionType
          : 'focus';
        const parsedDuration = Number.isInteger(Number(durationMinutes)) && Number(durationMinutes) > 0 && Number(durationMinutes) <= 120
          ? Number(durationMinutes)
          : null;

        const { room: updated, alreadyRunning } = await persistStart(
          room.roomCode,
          now,
          presentUserIds(room.roomCode),
          validSessionType,
          parsedDuration
        );
        if (alreadyRunning || !updated) {
          return emitError(socket, 'Timer is already running');
        }

        emitTimerState(io, updated);
        scheduleCompletion(io, updated);
        console.log(` Timer started in room ${updated.roomCode} (${validSessionType})`);
      } catch (err) {
        console.error('timer-start error:', err.message);
        emitError(socket, 'Failed to start timer');
      }
    });

    // timer-pause
    socket.on('timer-pause', async ({ roomCode } = {}) => {
      if (!checkSocketRate(socket, 'timer-pause')) return;
      try {
        const room = await loadRoom(socket, roomCode, { requireMember: true });
        if (!room) return;
        if (!authorizeSocketForRoomAction(socket, room, currentRoomCode, 'pause')) return;

        const { room: updated, notRunning, completed } = await persistPause(room.roomCode, Date.now());
        if (notRunning || !updated) {
          return emitError(socket, 'Timer is not running');
        }

        clearCompletion(updated.roomCode);
        if (completed) {
          try {
            await recordFocusSessions(updated, updated.timerAccumulatedMs, new Date());
          } catch (dbErr) {
            console.error(`FocusSession save error in ${updated.roomCode}:`, dbErr.message);
          }
        }
        emitTimerState(io, updated);
        console.log(` Timer paused in room ${updated.roomCode} (${Math.round((updated.timerRemainingMs || 0) / 1000)}s left)`);
      } catch (err) {
        console.error('timer-pause error:', err.message);
        emitError(socket, 'Failed to pause timer');
      }
    });

    // timer-resume 
    socket.on('timer-resume', async ({ roomCode } = {}) => {
      if (!checkSocketRate(socket, 'timer-resume')) return;
      try {
        const room = await loadRoom(socket, roomCode, { requireMember: true });
        if (!room) return;
        if (!authorizeSocketForRoomAction(socket, room, currentRoomCode, 'resume')) return;

        const { room: updated, notPaused } = await persistResume(
          room.roomCode,
          Date.now(),
          presentUserIds(room.roomCode)
        );
        if (notPaused || !updated) {
          return emitError(socket, 'Timer is not paused');
        }

        emitTimerState(io, updated);
        scheduleCompletion(io, updated);
        console.log(` Timer resumed in room ${updated.roomCode}`);
      } catch (err) {
        console.error('timer-resume error:', err.message);
        emitError(socket, 'Failed to resume timer');
      }
    });

    // timer-reset
    socket.on('timer-reset', async ({ roomCode } = {}) => {
      if (!checkSocketRate(socket, 'timer-reset')) return;
      try {
        const room = await loadRoom(socket, roomCode, { requireMember: true });
        if (!room) return;
        if (!authorizeSocketForRoomAction(socket, room, currentRoomCode, 'reset')) return;

        clearCompletion(room.roomCode);
        const now = Date.now();
        const { room: updated, snapshot, noop, lostRace } = await persistReset(room.roomCode, now);
        if (lostRace || !updated) {
          return emitError(socket, 'Failed to reset timer');
        }

        // F-03/F-08: Record sessions from the pre-reset snapshot.
        // recordFocusSessions internally guards timerSessionsRecorded and minimum duration,
        // so a single call handles all states (paused, completed) safely and idempotently.
        if (!noop && snapshot) {
          try {
            await recordFocusSessions(snapshot, snapshot.timerAccumulatedMs, new Date(now));
          } catch (dbErr) {
            console.error(`FocusSession save error in ${room.roomCode}:`, dbErr.message);
          }
        }

        emitTimerState(io, updated);
        console.log(` Timer reset in room ${updated.roomCode}`);
      } catch (err) {
        console.error('timer-reset error:', err.message);
        emitError(socket, 'Failed to reset timer');
      }
    });

    // disconnect 
    socket.on('disconnect', (reason) => {
      console.log(` Socket disconnected: ${socket.id} (${userName}) ${reason}`);
      cleanupSocketRate(socket.id);
      if (currentRoomCode) {
        removeUser(currentRoomCode, socket.id);
        broadcastPresence(io, currentRoomCode);
        currentRoomCode = null;
      }
    });
  });
};

initSocket.restoreTimers = restoreTimers;
initSocket.startTimerSweeper = startTimerSweeper;

module.exports = initSocket;
