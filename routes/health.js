const express = require('express');
const router = express.Router();

// GET /api/health
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Focus Room API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

module.exports = router;
