'use strict';

const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

router.get('/', (req, res) => {
  const isDbConnected = mongoose.connection.readyState === 1;
  const status = isDbConnected ? 'ok' : 'degraded';
  const httpStatus = isDbConnected ? 200 : 503;

  res.status(httpStatus).json({
    status,
    timestamp: new Date().toISOString(),
    services: {
      database: isDbConnected ? 'connected' : 'disconnected',
    },
  });
});

module.exports = router;
