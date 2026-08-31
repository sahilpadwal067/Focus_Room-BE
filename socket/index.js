/**
 * Socket.io handler — Phase 4 (timer) + Phase 5 (presence).
 *
 * ── Timer events received ──────────────────────────────────────────────────
 *   join-room      { roomCode }
 *   leave-room     { roomCode }
 *   timer-start    { roomCode }
 *   timer-pause    { roomCode }
 *   timer-resume   { roomCode }
 *   timer-reset    { roomCode }
 *
 * ── Presence events received ───────────────────────────────────────────────
 *   presence-status { roomCode, status }   — client reports its own status
 *
 * ── Events emitted ────────────────────────────────────────────────────────
 *   timer-state      <TimerStatePayload>   — broadcast to room
 *   room-error       { message }           — to offending socket only
 *   presence-update  { users: [...] }      — broadcast to room on any change
 */

const socketAuth = require('../middleware/socketAuth');
const Room = require('../models/Room');
const FocusSession = require('../models/FocusSession');
const { buildTimerState } = require('../utils/timerHelper');

// ─── In-memory presence store ─────────────────────────────────────────────────
// Map<roomCode, Map<socketId, { userId, name, status }>>
const presenceMap = new Map();

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

/** Build the array sent to clients — no sensitive fields */
function presenceList(roomCode) {
  const room = presenceMap.get(roomCode);
  if (!room) return [];
  return Array.from(room.values()).map(({ userId, name, status }) => ({
    userId,
    name,
    status,
  }));
}

function broadcastPresence(io, roomCode) {
  io.to(roomCode).emit('presence-update', { users: presenceList(roomCode) });
}

// ─── Timer in-memory completion timers ────────────────────────────────────────
const completionTimers = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const emitError = (socket, message) => socket.emit('room-error', { message });

async function loadRoom(socket, roomCode) {
  if (!roomCode || typeof roomCode !== 'string') {
    emitError(socket, 'Room code required');
    return null;
  }
  const code = roomCode.trim().toUpperCase();
  const room = await Room.findOne({ roomCode: code });
  if (!room) {
    emitError(socket, 'Room not found');
    return null;
  }
  return room;
}

async function broadcastAndPersist(io, room) {
  const state = buildTimerState(room);
  io.to(room.roomCode).emit('timer-state', state);
  await room.save();
  return state;
}

function scheduleCompletion(io, room) {
  clearCompletion(room.roomCode);
  const baseMs = room.timerRemainingMs ?? room.timerDuration * 60 * 1000;
  const elapsed = Date.now() - room.timerStartedAt;
  const remaining = Math.max(0, baseMs - elapsed);
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
    const room = await Room.findOne({ roomCode });
    if (!room || room.timerStatus !== 'running') return;

    const completedAt = new Date();
    const sessionType = room.currentSessionType;
    const durationMinutes = room.timerDuration;
    // startedAt = exactly durationMinutes before completion (the full timer ran)
    const startedAt = new Date(completedAt.getTime() - durationMinutes * 60 * 1000);

    room.timerStatus = 'completed';
    room.timerRemainingMs = 0;
    room.timerStartedAt = null;
    await broadcastAndPersist(io, room);
    console.log(`⏰ Timer completed in room ${roomCode}`);

    // ── Record focus sessions (only for focus-type, not breaks) ─────────────
    if (sessionType === 'focus') {
      const usersInRoom = presenceList(roomCode);
      if (usersInRoom.length > 0) {
        const sessionDocs = usersInRoom.map(({ userId }) => ({
          user: userId,
          room: room._id,
          durationMinutes,
          sessionType,
          startedAt,
          completedAt,
        }));
        try {
          await FocusSession.insertMany(sessionDocs, { ordered: false });
          console.log(`📝 Recorded ${sessionDocs.length} focus session(s) for room ${roomCode}`);
        } catch (dbErr) {
          // Log but don't crash — presence/timer state is already persisted
          console.error(`FocusSession save error in ${roomCode}:`, dbErr.message);
        }
      }
    }
  } catch (err) {
    console.error(`Completion handler error for ${roomCode}:`, err.message);
  }
}

// ─── Main init ────────────────────────────────────────────────────────────────

const initSocket = (io) => {
  io.use(socketAuth);

  io.on('connection', (socket) => {
    const user = socket.user;
    const userName = user?.name || 'Unknown';
    console.log(`🔌 Socket connected: ${socket.id} (${userName})`);

    // Track which room this socket is currently in (for disconnect cleanup)
    let currentRoomCode = null;

    // ── join-room ─────────────────────────────────────────────────────────────
    socket.on('join-room', async ({ roomCode } = {}) => {
      try {
        const room = await loadRoom(socket, roomCode);
        if (!room) return;

        // If already in a different room, leave it first
        if (currentRoomCode && currentRoomCode !== room.roomCode) {
          await socket.leave(currentRoomCode);
          removeUser(currentRoomCode, socket.id);
          broadcastPresence(io, currentRoomCode);
        }

        await socket.join(room.roomCode);
        currentRoomCode = room.roomCode;
        console.log(`👤 ${userName} joined room ${room.roomCode}`);

        // Add to presence — default status 'idle'
        addUser(room.roomCode, socket.id, user._id, userName, 'idle');
        broadcastPresence(io, room.roomCode);

        // Send timer state to joining socket
        socket.emit('timer-state', buildTimerState(room));

        // Reschedule completion if server restarted mid-run
        if (room.timerStatus === 'running' && room.timerStartedAt) {
          const elapsed = Date.now() - room.timerStartedAt;
          const base = room.timerRemainingMs ?? room.timerDuration * 60 * 1000;
          if (elapsed >= base) {
            await handleCompletion(io, room.roomCode);
          } else if (!completionTimers.has(room.roomCode)) {
            scheduleCompletion(io, room);
          }
        }
      } catch (err) {
        console.error('join-room error:', err.message);
        emitError(socket, 'Failed to join room');
      }
    });

    // ── leave-room ────────────────────────────────────────────────────────────
    socket.on('leave-room', async ({ roomCode } = {}) => {
      if (!roomCode) return;
      const code = roomCode.trim().toUpperCase();
      await socket.leave(code);
      removeUser(code, socket.id);
      if (currentRoomCode === code) currentRoomCode = null;
      broadcastPresence(io, code);
      console.log(`👋 ${userName} left room ${code}`);
    });

    // ── presence-status ───────────────────────────────────────────────────────
    socket.on('presence-status', ({ roomCode, status } = {}) => {
      if (!roomCode || !status) return;
      const code = roomCode.trim().toUpperCase();
      // Only allow update if this socket is actually in the room
      if (currentRoomCode !== code) return;
      const allowed = ['focusing', 'on break', 'idle'];
      if (!allowed.includes(status)) return;
      updateStatus(code, socket.id, status);
      broadcastPresence(io, code);
    });

    // ── timer-start ───────────────────────────────────────────────────────────
    socket.on('timer-start', async ({ roomCode } = {}) => {
      try {
        const room = await loadRoom(socket, roomCode);
        if (!room) return;
        if (room.timerStatus === 'running') return emitError(socket, 'Timer is already running');

        const totalMs = room.timerDuration * 60 * 1000;
        const isReset = room.timerStatus === 'idle'
          || room.timerStatus === 'completed'
          || room.timerRemainingMs === 0
          || room.timerRemainingMs === null;

        room.timerStatus = 'running';
        room.timerStartedAt = Date.now();
        room.timerRemainingMs = isReset ? totalMs : room.timerRemainingMs;

        await broadcastAndPersist(io, room);
        scheduleCompletion(io, room);
        console.log(`▶️  Timer started in room ${room.roomCode}`);
      } catch (err) {
        console.error('timer-start error:', err.message);
        emitError(socket, 'Failed to start timer');
      }
    });

    // ── timer-pause ───────────────────────────────────────────────────────────
    socket.on('timer-pause', async ({ roomCode } = {}) => {
      try {
        const room = await loadRoom(socket, roomCode);
        if (!room) return;
        if (room.timerStatus !== 'running') return emitError(socket, 'Timer is not running');

        const elapsed = Date.now() - room.timerStartedAt;
        const base = room.timerRemainingMs ?? room.timerDuration * 60 * 1000;
        const remaining = Math.max(0, base - elapsed);

        room.timerStatus = 'paused';
        room.timerRemainingMs = remaining;
        room.timerStartedAt = null;

        clearCompletion(room.roomCode);
        await broadcastAndPersist(io, room);
        console.log(`⏸  Timer paused in room ${room.roomCode} (${Math.round(remaining / 1000)}s left)`);
      } catch (err) {
        console.error('timer-pause error:', err.message);
        emitError(socket, 'Failed to pause timer');
      }
    });

    // ── timer-resume ──────────────────────────────────────────────────────────
    socket.on('timer-resume', async ({ roomCode } = {}) => {
      try {
        const room = await loadRoom(socket, roomCode);
        if (!room) return;
        if (room.timerStatus !== 'paused') return emitError(socket, 'Timer is not paused');

        room.timerStatus = 'running';
        room.timerStartedAt = Date.now();

        await broadcastAndPersist(io, room);
        scheduleCompletion(io, room);
        console.log(`▶️  Timer resumed in room ${room.roomCode}`);
      } catch (err) {
        console.error('timer-resume error:', err.message);
        emitError(socket, 'Failed to resume timer');
      }
    });

    // ── timer-reset ───────────────────────────────────────────────────────────
    socket.on('timer-reset', async ({ roomCode } = {}) => {
      try {
        const room = await loadRoom(socket, roomCode);
        if (!room) return;

        clearCompletion(room.roomCode);
        room.timerStatus = 'idle';
        room.timerStartedAt = null;
        room.timerRemainingMs = room.timerDuration * 60 * 1000;

        await broadcastAndPersist(io, room);
        console.log(`🔄 Timer reset in room ${room.roomCode}`);
      } catch (err) {
        console.error('timer-reset error:', err.message);
        emitError(socket, 'Failed to reset timer');
      }
    });

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`🔌 Socket disconnected: ${socket.id} (${userName}) — ${reason}`);
      if (currentRoomCode) {
        removeUser(currentRoomCode, socket.id);
        broadcastPresence(io, currentRoomCode);
        currentRoomCode = null;
      }
    });
  });
};

module.exports = initSocket;
