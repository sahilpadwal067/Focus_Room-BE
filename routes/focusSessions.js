const express = require('express');
const router = express.Router();
const protect = require('../middleware/auth');
const FocusSession = require('../models/FocusSession');

// All routes require JWT auth
router.use(protect);

/**
 * GET /api/focus-sessions
 * Returns only the authenticated user's own focus sessions (most recent first).
 */
router.get('/', async (req, res) => {
  try {
    const sessions = await FocusSession.find({ user: req.user._id })
      .sort({ completedAt: -1 })
      .populate('room', 'name roomCode')
      .lean();

    res.json({ sessions });
  } catch (err) {
    console.error('GET /api/focus-sessions error:', err.message);
    res.status(500).json({ message: 'Failed to retrieve sessions' });
  }
});

module.exports = router;
