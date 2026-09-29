'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const connectDB = require('./config/db');
const healthRoute = require('./routes/health');
const authRoute = require('./routes/auth');
const roomsRoute = require('./routes/rooms');
const focusSessionsRoute = require('./routes/focusSessions');
const dashboardRoute = require('./routes/dashboard');
const initSocket = require('./socket/index');

const PLACEHOLDER_SECRET_PATTERNS = [
  /replace_/i,
  /replace-/i,
  /replace with/i,
  /changeme/i,
  /your_/i,
  /<username>/i,
  /<password>/i,
  /xxxxx/,
  /^example$/i,
  /^test$/i,
  /changethis/i,
  /default_?secret/i,
  /foo|bar|baz|qux/i,
];

function isPlaceholder(value) {
  if (!value || typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (trimmed.length < 8) return true;
  return PLACEHOLDER_SECRET_PATTERNS.some((re) => re.test(trimmed));
}

function validateStartupEnv() {
  const errors = [];
  const env = process.env;

  if (!env.MONGODB_URI) {
    errors.push('MONGODB_URI is required');
  } else if (isPlaceholder(env.MONGODB_URI)) {
    errors.push('MONGODB_URI looks like a placeholder — set a real MongoDB connection string');
  }

  if (!env.JWT_SECRET) {
    errors.push('JWT_SECRET is required');
  } else if (isPlaceholder(env.JWT_SECRET)) {
    errors.push('JWT_SECRET looks like a placeholder — set a long random secret string');
  }

  if (!env.CLIENT_URL) {
    errors.push('CLIENT_URL is required (the origin of the frontend)');
  }

  const isProd = String(env.NODE_ENV).toLowerCase() === 'production';
  if (isProd) {
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(env.CLIENT_URL || '')) {
      errors.push('CLIENT_URL points to localhost in production — set the real frontend origin');
    }
  }

  return errors;
}

const startupEnvErrors = validateStartupEnv();
if (startupEnvErrors.length > 0) {
  console.error('FATAL: Refusing to start due to missing or invalid environment configuration:');
  for (const msg of startupEnvErrors) console.error(`  - ${msg}`);
  console.error('Check server/.env or your deployment environment variables.');
  process.exit(1);
}

const IS_PRODUCTION = String(process.env.NODE_ENV).toLowerCase() === 'production';
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS) || (IS_PRODUCTION ? 1 : 0);
const CORS_ORIGINS = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(',').map((url) => url.trim()).filter(Boolean)
  : ['http://localhost:5173'];

const strictLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts, please try again later' },
});

const moderateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please slow down' },
});

const apiFallbackLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Rate limit exceeded' },
});

const app = express();
const httpServer = http.createServer(app);

if (TRUST_PROXY_HOPS > 0) {
  app.set('trust proxy', TRUST_PROXY_HOPS);
}

// F-22: Correlation ID middleware
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  },
});

const helmetOptions = IS_PRODUCTION
  ? {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'https:'],
          'connect-src': ["'self'", ...CORS_ORIGINS],
          'font-src': ["'self'", 'data:'],
          'frame-ancestors': ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    }
  : {
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      hsts: false,
    };
app.use(helmet(helmetOptions));

app.use(compression());

app.use(cors({
  origin: CORS_ORIGINS,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
  preflightContinue: false,
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

app.use('/api/health', healthRoute);
app.use('/api/auth/register', strictLimit);
app.use('/api/auth/login', strictLimit);
app.use('/api/auth/logout', moderateLimit);
app.use('/api/auth', authRoute);
app.use('/api/rooms', moderateLimit, roomsRoute);
app.use('/api/focus-sessions', apiFallbackLimit, focusSessionsRoute);
app.use('/api/dashboard', apiFallbackLimit, dashboardRoute);

app.use('/api/*', (req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

initSocket(io);

// F-22: Production-safe global error handler
app.use((err, req, res, next) => {
  const status = Number(err.status || err.statusCode) || 500;
  const isProd = IS_PRODUCTION;
  const safeMessage = status >= 500
    ? 'Internal Server Error'
    : (err.message || 'Error');

  if (status >= 500) {
    console.error(`[${req.id || '-'}] 500 on ${req.method} ${req.originalUrl}:`, err.stack || err.message);
  } else {
    console.warn(`[${req.id || '-'}] ${status} on ${req.method} ${req.originalUrl}: ${err.message}`);
  }

  res.status(status).json({
    message: safeMessage,
    requestId: req.id,
    ...(!isProd && status >= 500 ? { error: err.message, stack: err.stack } : {}),
  });
});

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await connectDB();
  try {
    await initSocket.restoreTimers(io);
    console.log('Timer state restored from MongoDB');
  } catch (err) {
    console.error('Timer restore failed:', err.message);
  }
  initSocket.startTimerSweeper(io);
  httpServer.listen(PORT, () => {
    if (IS_PRODUCTION) {
      console.log(`Focus Room server running in production on port ${PORT}`);
    } else {
      console.log(`Server running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`CORS origins: ${CORS_ORIGINS.join(', ')}`);
    }
  });
};

// F-24: Graceful shutdown
const handleShutdown = async (signal) => {
  console.log(`Received ${signal}. Gracefully shutting down...`);
  httpServer.close(async () => {
    try {
      await mongoose.disconnect();
      console.log('MongoDB connection closed.');
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err.message);
      process.exit(1);
    }
  });
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

startServer();
