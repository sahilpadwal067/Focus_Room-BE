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

    // ── Timer configuration ────────────────────────────────────────────────────
    timerDuration: {
      type: Number,
      default: 25, // minutes
      min: [1, 'Timer duration must be at least 1 minute'],
      max: [120, 'Timer duration cannot exceed 120 minutes'],
    },

    // ── Server-authoritative timer state ──────────────────────────────────────
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
     * When running:  actual remaining = timerRemainingMs − (Date.now() − timerStartedAt)
     * When paused:   actual remaining = timerRemainingMs  (frozen)
     * When idle:     timerRemainingMs = timerDuration * 60 * 1000
     */
    timerRemainingMs: {
      type: Number,
      default: null, // null = use timerDuration * 60000
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Room', roomSchema);
