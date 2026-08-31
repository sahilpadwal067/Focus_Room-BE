require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const connectDB = require('./config/db');
const healthRoute = require('./routes/health');
const authRoute = require('./routes/auth');
const roomsRoute = require('./routes/rooms');
const focusSessionsRoute = require('./routes/focusSessions');
const dashboardRoute = require('./routes/dashboard');
const initSocket = require('./socket/index');

// ─── App Setup ───────────────────────────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/health', healthRoute);
app.use('/api/auth', authRoute);
app.use('/api/rooms', roomsRoute);
app.use('/api/focus-sessions', focusSessionsRoute);
app.use('/api/dashboard', dashboardRoute);

// 404 handler for unknown API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
initSocket(io);

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.stack);
  res.status(err.status || 500).json({
    message: err.message || 'Internal Server Error',
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await connectDB();
  httpServer.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 Socket.io ready`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  });
};

startServer();
