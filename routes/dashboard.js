const express = require('express');
const router = express.Router();
const protect = require('../middleware/auth');
const FocusSession = require('../models/FocusSession');

router.use(protect);

/**
 * GET /api/dashboard/stats
 * Returns productivity statistics for the authenticated user only.
 * All values default to zero if the user has no sessions.
 */
router.get('/stats', async (req, res) => {
  try {
    const userId = req.user._id;
    const now = new Date();

    // ── Time boundaries (server's local day) ──────────────────────────────────
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd   = new Date(todayStart.getTime() + 86400000);

    // Current week: Monday as week start
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon … 6=Sat
    const diffToMonday = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday);
    const weekEnd   = new Date(weekStart.getTime() + 7 * 86400000);

    const baseMatch = { user: userId, sessionType: 'focus' };

    // ── Run all aggregations in parallel ──────────────────────────────────────
    const [todayAgg, weekAgg, totalAgg, allDatesAgg] = await Promise.all([
      // Today's totals
      FocusSession.aggregate([
        { $match: { ...baseMatch, completedAt: { $gte: todayStart, $lt: todayEnd } } },
        { $group: { _id: null, minutes: { $sum: '$durationMinutes' }, count: { $sum: 1 } } },
      ]),

      // This week's daily breakdown
      FocusSession.aggregate([
        { $match: { ...baseMatch, completedAt: { $gte: weekStart, $lt: weekEnd } } },
        {
          $group: {
            _id: { $dayOfWeek: '$completedAt' }, // 1=Sun, 2=Mon … 7=Sat
            minutes: { $sum: '$durationMinutes' },
          },
        },
      ]),

      // All-time total sessions
      FocusSession.countDocuments(baseMatch),

      // Unique days with at least one focus session (for streak)
      FocusSession.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: {
              y: { $year: '$completedAt' },
              m: { $month: '$completedAt' },
              d: { $dayOfMonth: '$completedAt' },
            },
          },
        },
        { $sort: { '_id.y': -1, '_id.m': -1, '_id.d': -1 } },
      ]),
    ]);

    // ── Today stats ───────────────────────────────────────────────────────────
    const todayFocusMinutes = todayAgg[0]?.minutes ?? 0;
    const todaySessions     = todayAgg[0]?.count ?? 0;

    // ── Week stats ────────────────────────────────────────────────────────────
    // MongoDB $dayOfWeek: 1=Sun 2=Mon 3=Tue 4=Wed 5=Thu 6=Fri 7=Sat
    // Map to: Mon=0 Tue=1 Wed=2 Thu=3 Fri=4 Sat=5 Sun=6
    const DOW_LABEL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const weekMap = new Array(7).fill(0); // index 0=Mon … 6=Sun

    for (const { _id, minutes } of weekAgg) {
      // _id is MongoDB $dayOfWeek (1=Sun … 7=Sat)
      const idx = _id === 1 ? 6 : _id - 2; // Sun(1)→6, Mon(2)→0, …, Sat(7)→5
      if (idx >= 0 && idx < 7) weekMap[idx] += minutes;
    }

    const weeklyData   = DOW_LABEL.map((day, i) => ({ day, minutes: weekMap[i] }));
    const weekFocusMinutes = weekMap.reduce((a, b) => a + b, 0);

    // ── Streak ────────────────────────────────────────────────────────────────
    // Build a Set of "YYYY-MM-DD" strings for days with focus sessions
    const daySet = new Set(
      allDatesAgg.map(({ _id: { y, m, d } }) =>
        `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      )
    );

    let currentStreak = 0;
    // Walk backwards from today until we find a day with no session
    const cursor = new Date(todayStart);
    while (true) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
      if (!daySet.has(key)) break;
      currentStreak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    res.json({
      todayFocusMinutes,
      todaySessions,
      currentStreak,
      weekFocusMinutes,
      totalSessions: totalAgg,
      weeklyData,
    });
  } catch (err) {
    console.error('GET /api/dashboard/stats error:', err.message);
    res.status(500).json({ message: 'Failed to load dashboard statistics' });
  }
});

module.exports = router;
