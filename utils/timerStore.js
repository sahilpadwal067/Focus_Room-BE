/**
 * Authoritative timer mutations. MongoDB is the source of truth.
 * In-memory timeouts are only an optimisation for timely broadcasts.
 */

const Room = require('../models/Room');
const FocusSession = require('../models/FocusSession');
const mongoose = require('mongoose');
const {
  totalDurationMs,
  computeRemainingMs,
  computeFocusedDurationMs,
  computeEndsAt,
  shouldFinalizeTimer,
  durationMinutesFromMs,
  uniqueUserIds,
} = require('./timerHelper');

function isBenignDuplicateError(err) {
  if (!err) return false;
  if (err.code === 11000) return true;
  const errors = err.writeErrors || err.result?.writeErrors || [];
  if (errors.length > 0) {
    return errors.every((e) => e.code === 11000);
  }
  return false;
}

async function recordFocusSessions(room, focusedMs, completedAt) {
  if (!room || room.currentSessionType !== 'focus') {
    await markSessionsRecorded(room);
    return { recorded: 0, skipped: true };
  }
  if (room.timerSessionsRecorded) {
    return { recorded: 0, skipped: true };
  }

  const minutes = durationMinutesFromMs(focusedMs);
  if (minutes < 1) {
    await markSessionsRecorded(room);
    return { recorded: 0, skipped: true };
  }

  const userIds = uniqueUserIds(room.timerParticipantIds);
  if (userIds.length === 0) {
    await markSessionsRecorded(room);
    return { recorded: 0, skipped: true };
  }

  const startedAt = room.timerCycleStartedAt
    ? new Date(room.timerCycleStartedAt)
    : new Date(completedAt.getTime() - focusedMs);

  const docs = userIds.map((userId) => ({
    user: userId,
    room: room._id,
    durationMinutes: minutes,
    sessionType: 'focus',
    startedAt,
    completedAt,
    timerCycleId: room.timerCycleId,
  }));

  try {
    await FocusSession.insertMany(docs, { ordered: false });
    await markSessionsRecorded(room);
    return { recorded: docs.length, skipped: false };
  } catch (err) {
    if (isBenignDuplicateError(err)) {
      await markSessionsRecorded(room);
      return { recorded: 0, skipped: true, duplicate: true };
    }
    console.error(`FocusSession save error in ${room.roomCode}:`, err.message);
    throw err;
  }
}

async function markSessionsRecorded(room) {
  if (!room?._id) return;
  await Room.updateOne(
    { _id: room._id, timerCycleId: room.timerCycleId },
    { $set: { timerSessionsRecorded: true } }
  );
}

async function addParticipant(roomId, userId) {
  if (!roomId || !userId) return;
  await Room.updateOne(
    {
      _id: roomId,
      timerStatus: { $in: ['running', 'paused'] },
    },
    { $addToSet: { timerParticipantIds: userId } }
  );
}

async function persistStart(roomCode, now, participantIds, sessionType = 'focus', customDuration = null) {
  const participants = uniqueUserIds(participantIds)
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const validSessionType = ['focus', 'short_break', 'long_break'].includes(sessionType)
    ? sessionType
    : 'focus';

  const durationMinutes = Number.isInteger(Number(customDuration)) && Number(customDuration) > 0 && Number(customDuration) <= 120
    ? Number(customDuration)
    : null;

  const fresh = await Room.findOneAndUpdate(
    { roomCode, timerStatus: { $in: ['idle', 'completed'] } },
    [
      {
        $set: {
          currentSessionType: validSessionType,
          ...(durationMinutes ? { timerDuration: durationMinutes } : {}),
          timerStatus: 'running',
          timerStartedAt: now,
          timerRemainingMs: durationMinutes
            ? durationMinutes * 60000
            : { $multiply: ['$timerDuration', 60000] },
          timerEndsAt: durationMinutes
            ? now + durationMinutes * 60000
            : { $add: [now, { $multiply: ['$timerDuration', 60000] }] },
          timerAccumulatedMs: 0,
          timerCycleStartedAt: now,
          timerSessionsRecorded: false,
          timerParticipantIds: participants,
          timerCycleId: { $add: [{ $ifNull: ['$timerCycleId', 0] }, 1] },
        },
      },
    ],
    { new: true }
  );
  if (fresh) return { room: fresh, alreadyRunning: false };

  const running = await Room.findOne({ roomCode, timerStatus: 'running' });
  if (running) return { room: null, alreadyRunning: true };

  return persistResume(roomCode, now, participantIds);
}

async function persistPause(roomCode, now) {
  // F-08: Fully atomic — attempt the conditional write first.
  // The { timerStatus: 'running' } filter is the authoritative gate;
  // no preliminary findOne is needed, eliminating the TOCTOU window.
  const room = await Room.findOneAndUpdate(
    { roomCode, timerStatus: 'running' },
    [
      {
        $set: {
          timerAccumulatedMs: {
            $min: [
              { $multiply: ['$timerDuration', 60000] },
              {
                $add: [
                  { $ifNull: ['$timerAccumulatedMs', 0] },
                  {
                    $max: [
                      0,
                      { $subtract: [now, { $ifNull: ['$timerStartedAt', now] }] },
                    ],
                  },
                ],
              },
            ],
          },
          timerRemainingMs: {
            $max: [
              0,
              {
                $subtract: [
                  { $ifNull: ['$timerRemainingMs', { $multiply: ['$timerDuration', 60000] }] },
                  { $subtract: [now, { $ifNull: ['$timerStartedAt', now] }] },
                ],
              },
            ],
          },
          timerStatus: 'paused',
          timerStartedAt: null,
          timerEndsAt: null,
        },
      },
    ],
    { new: true }
  );

  // Timer was not in 'running' state — concurrent pause already won, or timer was not running.
  if (!room) return { room: null, notRunning: true };

  // If remaining time is zero (timer expired while we were writing), finalize as completed.
  // F-03: timerAccumulatedMs already reflects the full focused duration from the pipeline above.
  if ((room.timerRemainingMs ?? 0) <= 0) {
    const completed = await Room.findOneAndUpdate(
      { roomCode, timerStatus: 'paused', timerRemainingMs: { $lte: 0 } },
      {
        $set: {
          timerStatus: 'completed',
          timerRemainingMs: 0,
          timerStartedAt: null,
          timerEndsAt: null,
        },
      },
      { new: true }
    );
    return { room: completed || room, completed: true };
  }

  return { room, completed: false };
}

async function persistResume(roomCode, now, extraParticipantIds) {
  const room = await Room.findOneAndUpdate(
    {
      roomCode,
      timerStatus: 'paused',
      timerRemainingMs: { $gt: 0 },
    },
    [
      {
        $set: {
          timerStatus: 'running',
          timerStartedAt: now,
          timerEndsAt: {
            $add: [now, { $ifNull: ['$timerRemainingMs', 0] }],
          },
        },
      },
    ],
    { new: true }
  );

  if (!room) return { room: null, notPaused: true };

  const extras = uniqueUserIds(extraParticipantIds);
  for (const id of extras) {
    await addParticipant(room._id, id);
  }
  const reloaded = extras.length ? await Room.findById(room._id) : room;
  return { room: reloaded || room, notPaused: false };
}

async function persistComplete(roomCode, now) {
  const room = await Room.findOneAndUpdate(
    {
      roomCode,
      timerStatus: 'running',
      $expr: {
        $lte: [
          {
            $ifNull: [
              '$timerEndsAt',
              {
                $subtract: [
                  { $add: [{ $ifNull: ['$timerStartedAt', now] }, { $ifNull: ['$timerRemainingMs', 0] }] },
                  0,
                ],
              },
            ],
          },
          now,
        ],
      },
    },
    [
      {
        $set: {
          timerAccumulatedMs: {
            $min: [
              { $multiply: ['$timerDuration', 60000] },
              {
                $add: [
                  { $ifNull: ['$timerAccumulatedMs', 0] },
                  {
                    $max: [
                      0,
                      { $subtract: [now, { $ifNull: ['$timerStartedAt', now] }] },
                    ],
                  },
                ],
              },
            ],
          },
          timerStatus: 'completed',
          timerRemainingMs: 0,
          timerStartedAt: null,
          timerEndsAt: null,
        },
      },
    ],
    { new: true }
  );

  if (!room) return { room: null, alreadyFinal: true };
  return { room, alreadyFinal: false };
}

async function persistReset(roomCode, now) {
  let current = await Room.findOne({ roomCode });
  if (!current) return { room: null };

  if (current.timerStatus === 'idle') {
    return { room: current, snapshot: null, noop: true };
  }

  if (current.timerStatus === 'running' && shouldFinalizeTimer(current, now)) {
    const completed = await persistComplete(roomCode, now);
    current = completed.room || await Room.findOne({ roomCode });
    if (!current) return { room: null };
  } else if (current.timerStatus === 'running') {
    const paused = await persistPause(roomCode, now);
    current = paused.room || await Room.findOne({ roomCode });
    if (!current) return { room: null };
  }

  const snapshot = {
    timerStatus: current.timerStatus,
    timerAccumulatedMs: computeFocusedDurationMs(current, now),
    timerCycleId: current.timerCycleId,
    timerCycleStartedAt: current.timerCycleStartedAt,
    currentSessionType: current.currentSessionType,
    timerParticipantIds: current.timerParticipantIds || [],
    timerSessionsRecorded: current.timerSessionsRecorded,
    _id: current._id,
    roomCode: current.roomCode,
    timerDuration: current.timerDuration,
  };

  const room = await Room.findOneAndUpdate(
    {
      roomCode,
      timerCycleId: current.timerCycleId,
      timerStatus: { $in: ['paused', 'completed'] },
    },
    [
      {
        $set: {
          timerStatus: 'idle',
          currentSessionType: 'focus',
          timerStartedAt: null,
          timerEndsAt: null,
          timerRemainingMs: { $multiply: ['$timerDuration', 60000] },
          timerAccumulatedMs: 0,
          timerCycleStartedAt: null,
          timerParticipantIds: [],
          timerSessionsRecorded: false,
        },
      },
    ],
    { new: true }
  );

  if (!room) return { room: null, lostRace: true };
  return { room, snapshot, noop: false };
}

async function backfillRunningEndsAt(room, now) {
  if (room.timerStatus !== 'running') return room;
  if (typeof room.timerEndsAt === 'number') return room;
  const endsAt = computeEndsAt(room, now);
  const updated = await Room.findOneAndUpdate(
    { _id: room._id, timerStatus: 'running', timerEndsAt: null },
    { $set: { timerEndsAt: endsAt } },
    { new: true }
  );
  return updated || room;
}

module.exports = {
  recordFocusSessions,
  addParticipant,
  persistStart,
  persistPause,
  persistResume,
  persistComplete,
  persistReset,
  backfillRunningEndsAt,
  isBenignDuplicateError,
  computeRemainingMs,
  computeFocusedDurationMs,
  totalDurationMs,
};
