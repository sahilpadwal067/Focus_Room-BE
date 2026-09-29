'use strict';

const express = require('express');
const Room = require('../models/Room');
const protect = require('../middleware/auth');
const { generateRoomCode, normalizeRoomCode } = require('../utils/roomCode');

const router = express.Router();

router.use(protect);

function isRoomUser(user, room) {
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

const MAX_ROOM_CODE_ATTEMPTS = 5;

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

    // F-05: The unique index is the authoritative gate; retry with fresh code on 11000 collision.
    let room = null;
    for (let attempt = 1; attempt <= MAX_ROOM_CODE_ATTEMPTS; attempt++) {
      const roomCode = generateRoomCode();
      try {
        room = await Room.create({
          roomCode,
          name: name.trim(),
          createdBy: req.user._id,
          members: [req.user._id],
          ...(timerDuration ? { timerDuration: Number(timerDuration) } : {}),
        });
        break;
      } catch (err) {
        if (err.code === 11000 && err.keyPattern && err.keyPattern.roomCode) {
          continue;
        }
        throw err;
      }
    }

    if (!room) {
      console.error('Create room: could not allocate unique room code after', MAX_ROOM_CODE_ATTEMPTS, 'attempts');
      return res.status(500).json({ message: 'Server error while creating room, please try again' });
    }

    await room.populate('createdBy', 'name');
    res.status(201).json({ room: safeRoom(room) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const msg = Object.values(error.errors)[0].message;
      return res.status(400).json({ message: msg });
    }
    if (error.code === 11000 && error.keyPattern && error.keyPattern.roomCode) {
      return res.status(500).json({ message: 'Server error while creating room, please try again' });
    }
    console.error('Create room error:', error.message);
    res.status(500).json({ message: 'Server error while creating room' });
  }
});

router.post('/join', async (req, res) => {
  try {
    const code = normalizeRoomCode(req.body?.roomCode);
    if (!code) {
      return res.status(400).json({ message: 'Room code must be exactly 6 alphanumeric characters' });
    }

    const room = await Room.findOne({ roomCode: code }).populate('createdBy', 'name');
    if (!room) {
      return res.status(404).json({ message: 'Room not found — check the code and try again' });
    }

    if (!isRoomUser(req.user, room)) {
      try {
        await Room.findByIdAndUpdate(
          room._id,
          { $addToSet: { members: req.user._id } },
          { runValidators: true }
        );
        room.members = room.members || [];
        if (!room.members.some((m) => String(m) === String(req.user._id))) {
          room.members.push(req.user._id);
        }
      } catch (updateErr) {
        console.error('Join room member-add error:', updateErr.message);
        return res.status(500).json({ message: 'Server error while joining room' });
      }
    }

    res.json({ room: safeRoom(room) });
  } catch (error) {
    console.error('Join room error:', error.message);
    res.status(500).json({ message: 'Server error while joining room' });
  }
});

router.get('/:roomCode', async (req, res) => {
  try {
    const code = normalizeRoomCode(req.params?.roomCode);
    if (!code) {
      return res.status(400).json({ message: 'Invalid room code format' });
    }

    const room = await Room.findOne({ roomCode: code }).populate('createdBy', 'name');
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!isRoomUser(req.user, room)) {
      return res.status(403).json({ message: 'Not authorised to access this room' });
    }

    res.json({ room: safeRoom(room) });
  } catch (error) {
    console.error('Get room error:', error.message);
    res.status(500).json({ message: 'Server error while fetching room' });
  }
});

module.exports = router;
