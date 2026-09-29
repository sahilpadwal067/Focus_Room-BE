const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema(
  {
    roomCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z0-9]{6}$/, 'Room code must be exactly 6 alphanumeric characters'],
    },
    name: {
      type: String,
      required: [true, 'Room name is required'],
      trim: true,
      minlength: [2, 'Room name must be at least 2 characters'],
      maxlength: [50, 'Room name cannot exceed 50 characters'],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    /**
     * Users who have successfully joined this room (at least once via socket join-room).
     * Members + creator are the only users authorized to:
     *  - read room details via REST
     *  - control the timer (start/pause/resume/reset)
     * A shareable room code lets any authenticated user *join* and become a member.
     */
    members: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    }],

    //  Timer configuration
    timerDuration: {
      type: Number,
      default: 25, // minutes
      min: [1, 'Timer duration must be at least 1 minute'],
      max: [120, 'Timer duration cannot exceed 120 minutes'],
    },

    // Server-authoritative timer state
    timerStatus: {
      type: String,
      enum: ['idle', 'running', 'paused', 'completed'],
      default: 'idle',
    },
    currentSessionType: {
      type: String,
      enum: ['focus', 'short_break', 'long_break'],
      default: 'focus',
    },
    /**
     * Epoch ms when the timer was last started/resumed.
     * Only meaningful when timerStatus === 'running'.
     */
    timerStartedAt: {
      type: Number,
      default: null,
    },
    /**
     * Milliseconds remaining at the moment the timer was paused.
     * When running:  actual remaining = timerRemainingMs  (Date.now() timerStartedAt)
     * When paused:   actual remaining = timerRemainingMs  (frozen)
     * When idle:     timerRemainingMs = timerDuration * 60 * 1000
     */
    timerRemainingMs: {
      type: Number,
      default: null, // null = use timerDuration * 60000
    },
    /**
     * Epoch ms when the current running segment should reach zero.
     * Authoritative for restart reconstruction. Null when not running.
     */
    timerEndsAt: {
      type: Number,
      default: null,
    },
    /**
     * Focused milliseconds accumulated in the current cycle, excluding a live running segment.
     * Running segment time is added on pause/complete.
     */
    timerAccumulatedMs: {
      type: Number,
      default: 0,
      min: 0,
    },
    /**
     * Monotonic cycle id incremented each time a new pomodoro starts from idle/completed.
     * Used to uniquely identify FocusSession rows for this room cycle.
     */
    timerCycleId: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Epoch ms of the first start in this cycle (pause/resume do not change it). */
    timerCycleStartedAt: {
      type: Number,
      default: null,
    },
    /** Unique users who were present during this cycle (not socket ids). */
    timerParticipantIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    }],
    /** True once FocusSession rows for this cycle have been written (or intentionally skipped). */
    timerSessionsRecorded: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Room', roomSchema);
