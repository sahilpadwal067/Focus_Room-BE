const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Socket.io authentication middleware.
 * Expects: socket.handshake.auth.token = "Bearer <jwt>"  OR  just the raw token string.
 * On success: attaches socket.user (without password).
 */
const socketAuth = async (socket, next) => {
  try {
    let raw = socket.handshake.auth?.token || '';
    if (raw.startsWith('Bearer ')) raw = raw.slice(7);

    if (!raw) return next(new Error('AUTH_MISSING'));

    let decoded;
    try {
      decoded = jwt.verify(raw, process.env.JWT_SECRET);
    } catch {
      return next(new Error('AUTH_INVALID'));
    }

    if (!decoded || !decoded.id) return next(new Error('AUTH_INVALID'));

    const user = await User.findById(decoded.id).select('-password');
    if (!user) return next(new Error('AUTH_USER_GONE'));

    const tokenVersionInToken = Number(decoded.v) || 0;
    const tokenVersionInUser = Number(user.tokenVersion) || 0;
    if (tokenVersionInToken !== tokenVersionInUser) {
      return next(new Error('AUTH_REVOKED'));
    }

    socket.user = user;
    next();
  } catch (err) {
    next(new Error('AUTH_ERROR'));
  }
};

module.exports = socketAuth;
