'use strict';

const Room = require('../models/Room');

/**
 * Safe room cleanup utility (F-32).
 * Rooms are persistent shareable entities. This utility safely identifies
 * or removes stale rooms without risking active or recently used rooms.
 *
 * Safety rules:
 * 1. Never delete rooms that are currently active in memory / socket presence.
 * 2. Never delete rooms with timerStatus === 'running' or 'paused'.
 * 3. Only target rooms with timerStatus === 'idle' where updatedAt < cutoff.
 * 4. Defaults to dryRun = true to prevent accidental data loss.
 *
 * @param {Object} options
 * @param {number} options.olderThanDays - Age threshold in days (default: 90)
 * @param {boolean} options.dryRun - If true, only reports matching room count without deleting
 * @param {Set<string>|Array<string>} options.activeRoomCodes - Set of currently active roomCodes
 * @returns {Promise<{ matched: number, deleted: number, dryRun: boolean }>}
 */
async function cleanupStaleRooms({
  olderThanDays = 90,
  dryRun = true,
  activeRoomCodes = new Set(),
} = {}) {
  const activeSet = activeRoomCodes instanceof Set ? activeRoomCodes : new Set(activeRoomCodes);
  const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const filter = {
    timerStatus: 'idle',
    updatedAt: { $lt: cutoffDate },
    roomCode: { $nin: Array.from(activeSet) },
  };

  const matchedCount = await Room.countDocuments(filter);

  if (dryRun) {
    return { matched: matchedCount, deleted: 0, dryRun: true };
  }

  const result = await Room.deleteMany(filter);
  return { matched: matchedCount, deleted: result.deletedCount || 0, dryRun: false };
}

module.exports = { cleanupStaleRooms };
