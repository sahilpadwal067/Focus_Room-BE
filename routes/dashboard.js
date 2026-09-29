'use strict';

const express = require('express');
const router = express.Router();
const protect = require('../middleware/auth');
const FocusSession = require('../models/FocusSession');

router.use(protect);

/**
 * Compute UTC-equivalent day/week boundaries for a given IANA timezone (F-12, F-23).
 * Returns UTC Date objects for range queries, along with local calendar date and resolved timezone.
 */
function getUtcBoundaries(tz) {
  const now = new Date();
  let localDateStr;
  let offsetMinutes = 0;
  let resolvedTz = 'UTC';

  if (tz && typeof tz === 'string' && tz.length <= 64) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(now);
      localDateStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now);

      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'longOffset',
      }).formatToParts(now);
      const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+0:00';
      const match = tzName.match(/GMT([+-])(\d{1,2}):(\d{2})/);
      if (match) {
        const sign = match[1] === '+' ? 1 : -1;
        offsetMinutes = sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
      }
      resolvedTz = tz;
    } catch {
      localDateStr = undefined;
      resolvedTz = 'UTC';
    }
  }

  if (!localDateStr) {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    localDateStr = `${y}-${m}-${d}`;
    offsetMinutes = 0;
    resolvedTz = 'UTC';
  }

  const [year, month, day] = localDateStr.split('-').map(Number);
  const todayStartMs = Date.UTC(year, month - 1, day) - offsetMinutes * 60000;
  const todayStart = new Date(todayStartMs);
  const todayEnd = new Date(todayStartMs + 86400000);

  const tempDate = new Date(Date.UTC(year, month - 1, day));
  const dow = tempDate.getUTCDay();
  const diffToMonday = dow === 0 ? 6 : dow - 1;
  const weekStartMs = todayStartMs - diffToMonday * 86400000;
  const weekStart = new Date(weekStartMs);
  const weekEnd = new Date(weekStartMs + 7 * 86400000);

  return { todayStart, todayEnd, weekStart, weekEnd, localDateStr, resolvedTz, todayStartMs };
}

router.get('/stats', async (req, res) => {
  try {
    const userId = req.user._id;
    const { tz } = req.query;
    const { todayStart, todayEnd, weekStart, weekEnd, resolvedTz, todayStartMs } = getUtcBoundaries(tz);

    const baseMatch = { user: userId, sessionType: 'focus' };

    const [todayAgg, weekAgg, totalAgg, allDatesAgg] = await Promise.all([
      // Today's totals (covered by idx_user_sessionType_completedAt)
      FocusSession.aggregate([
        { $match: { ...baseMatch, completedAt: { $gte: todayStart, $lt: todayEnd } } },
        { $group: { _id: null, minutes: { $sum: '$durationMinutes' }, count: { $sum: 1 } } },
      ]),

      // This week's daily breakdown (covered by idx_user_sessionType_completedAt)
      FocusSession.aggregate([
        { $match: { ...baseMatch, completedAt: { $gte: weekStart, $lt: weekEnd } } },
        {
          $group: {
            _id: { $dayOfWeek: '$completedAt' },
            minutes: { $sum: '$durationMinutes' },
          },
        },
      ]),

      // All-time total sessions
      FocusSession.countDocuments(baseMatch),

      // F-23: Unique calendar dates in user's timezone for streak calculation
      FocusSession.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$completedAt',
                timezone: resolvedTz,
              },
            },
          },
        },
        { $sort: { _id: -1 } },
      ]),
    ]);

    const todayFocusMinutes = todayAgg[0]?.minutes ?? 0;
    const todaySessions = todayAgg[0]?.count ?? 0;

    const DOW_LABEL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const weekMap = new Array(7).fill(0);

    for (const { _id, minutes } of weekAgg) {
      const idx = _id === 1 ? 6 : _id - 2;
      if (idx >= 0 && idx < 7) weekMap[idx] += minutes;
    }

    const weeklyData = DOW_LABEL.map((day, i) => ({ day, minutes: weekMap[i] }));
    const weekFocusMinutes = weekMap.reduce((a, b) => a + b, 0);

    // F-23: Streak calculation matching user's local calendar days
    const daySet = new Set(allDatesAgg.map((d) => d._id).filter(Boolean));

    const getLocalDayKey = (dayOffset) => {
      const d = new Date(todayStartMs + dayOffset * 86400000 + 43200000);
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: resolvedTz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    };

    let currentStreak = 0;
    let dayOffset = null;

    const todayKey = getLocalDayKey(0);
    const yesterdayKey = getLocalDayKey(-1);

    if (daySet.has(todayKey)) {
      dayOffset = 0;
    } else if (daySet.has(yesterdayKey)) {
      dayOffset = -1;
    }

    if (dayOffset !== null) {
      while (true) {
        const key = getLocalDayKey(dayOffset);
        if (!daySet.has(key)) break;
        currentStreak++;
        dayOffset--;
      }
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
