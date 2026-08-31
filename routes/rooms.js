const express = require('express');
const Room = require('../models/Room');
const protect = require('../middleware/auth');

const router = express.Router();

// All room routes require authentication
router.use(protect);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a random 6-character uppercase alphanumeric code */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // exclude lookalike chars O/0, I/1
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/** Generate a unique code not already in the DB */
async function uniqueRoomCode() {
  let code;
  let attempts = 0;
  do {
    code = generateRoomCode();
    attempts++;
    if (attempts > 20) throw new Error('Could not generate unique room code');
  } while (await Room.exists({ roomCode: code }));
  return code;
}

/** Safe room object to send to clients (populated createdBy) */
function safeRoom(room) {
  return {
    _id: room._id,
    roomCode: room.roomCode,
    name: room.name,
    createdBy: room.createdBy
      ? { _id: room.createdBy._id, name: room.createdBy.name }
      : room.createdBy,
    timerDuration: room.timerDuration,
    timerStatus: room.timerStatus,
    currentSessionType: room.currentSessionType,
    createdAt: room.createdAt,
  };
}

// ─── POST /api/rooms — create a room ─────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, timerDuration } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ message: 'Room name must be at least 2 characters' });
    }
    if (name.trim().length > 50) {
      return res.status(400).json({ message: 'Room name cannot exceed 50 characters' });
    }
    if (timerDuration !== undefined) {
      const d = Number(timerDuration);
      if (!Number.isInteger(d) || d < 1 || d > 120) {
        return res.status(400).json({ message: 'Timer duration must be between 1 and 120 minutes' });
      }
    }

    const roomCode = await uniqueRoomCode();

    const room = await Room.create({
      roomCode,
      name: name.trim(),
      createdBy: req.user._id,
      ...(timerDuration ? { timerDuration: Number(timerDuration) } : {}),
    });

    // Populate creator info
    await room.populate('createdBy', 'name');

    res.status(201).json({ room: safeRoom(room) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const msg = Object.values(error.errors)[0].message;
      return res.status(400).json({ message: msg });
    }
    console.error('Create room error:', error.message);
    res.status(500).json({ message: 'Server error while creating room' });
  }
});

// ─── POST /api/rooms/join — join by code ──────────────────────────────────────
router.post('/join', async (req, res) => {
  try {
    const { roomCode } = req.body;

    if (!roomCode || typeof roomCode !== 'string') {
      return res.status(400).json({ message: 'Room code is required' });
    }

    const code = roomCode.trim().toUpperCase();

    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return res.status(400).json({ message: 'Room code must be exactly 6 alphanumeric characters' });
    }

    const room = await Room.findOne({ roomCode: code }).populate('createdBy', 'name');
    if (!room) {
      return res.status(404).json({ message: 'Room not found — check the code and try again' });
    }

    res.json({ room: safeRoom(room) });
  } catch (error) {
    console.error('Join room error:', error.message);
    res.status(500).json({ message: 'Server error while joining room' });
  }
});

// ─── GET /api/rooms/:roomCode — fetch room details ────────────────────────────
router.get('/:roomCode', async (req, res) => {
  try {
    const code = req.params.roomCode.trim().toUpperCase();

    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return res.status(400).json({ message: 'Invalid room code format' });
    }

    const room = await Room.findOne({ roomCode: code }).populate('createdBy', 'name');
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    res.json({ room: safeRoom(room) });
  } catch (error) {
    console.error('Get room error:', error.message);
    res.status(500).json({ message: 'Server error while fetching room' });
  }
});

module.exports = router;
