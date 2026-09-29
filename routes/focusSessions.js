'use strict';

const express = require('express');
const router = express.Router();
const protect = require('../middleware/auth');
const FocusSession = require('../models/FocusSession');

router.use(protect);

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/**
 * GET /api/focus-sessions
 * Returns only the authenticated user's own focus sessions (most recent first).
 * Query params: page (>= 1, default 1), limit (1-100, default 20).
 * Covered by idx_user_completedAt index.
 */
router.get('/', async (req, res) => {
  try {
    let page = parseInt(req.query.page, 10);
    let limit = parseInt(req.query.limit, 10);

    if (!Number.isFinite(page) || page < 1) page = 1;
    if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const skip = (page - 1) * limit;

    const [sessions, total] = await Promise.all([
      FocusSession.find({ user: req.user._id })
        .sort({ completedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('room', 'name roomCode')
        .lean(),
      FocusSession.countDocuments({ user: req.user._id }),
    ]);

    res.json({
      sessions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (err) {
    console.error('GET /api/focus-sessions error:', err.message);
    res.status(500).json({ message: 'Failed to retrieve sessions' });
  }
});

module.exports = router;
