const mongoose = require('mongoose');

const focusSessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Room',
      required: true,
    },
    durationMinutes: {
      type: Number,
      required: true,
      min: 1,
    },
    sessionType: {
      type: String,
      enum: ['focus', 'short_break', 'long_break'],
      required: true,
    },
    startedAt: {
      type: Date,
      required: true,
    },
    completedAt: {
      type: Date,
      required: true,
    },
    /**
     * Room.timerCycleId at the time this row was written.
     * Partial unique index (user + room + timerCycleId) prevents duplicate
     * sessions for the same user/room/cycle (multi-tab / concurrent complete).
     * Absent on historical documents; those are not migrated.
     */
    timerCycleId: {
      type: Number,
      min: 1,
    },
  },
  { timestamps: true }
);

focusSessionSchema.index(
  { user: 1, room: 1, timerCycleId: 1 },
  {
    unique: true,
    name: 'uniq_user_room_timerCycleId',
    partialFilterExpression: { timerCycleId: { $type: 'number' } },
  }
);

/**
 * F-17: Compound index for dashboard aggregations.
 * Covers: { user, sessionType, completedAt: { $gte, $lt } }
 * Used by today/week aggregate queries in dashboard/stats.
 */
focusSessionSchema.index(
  { user: 1, sessionType: 1, completedAt: -1 },
  { name: 'idx_user_sessionType_completedAt' }
);

/**
 * F-17: Compound index for paginated focus-session list.
 * Covers: find({ user }).sort({ completedAt: -1 }).skip().limit()
 * Also useful for the all-time count / streak aggregation.
 */
focusSessionSchema.index(
  { user: 1, completedAt: -1 },
  { name: 'idx_user_completedAt' }
);

module.exports = mongoose.model('FocusSession', focusSessionSchema);

