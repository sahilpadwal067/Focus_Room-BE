'use strict';

const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * JWT Authentication Middleware.
 * F-30: The primary key indexed User lookup (User.findById) is intentionally
 * retained on every protected request. This ensures immediate revocation when
 * tokenVersion is incremented on logout/password change, and guarantees the user
 * account still exists without unsafe in-memory caching.
 */
const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Not authorised no token provided' });
    }

    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: 'Not authorised token invalid or expired' });
    }

    if (!decoded || !decoded.id) {
      return res.status(401).json({ message: 'Not authorised token invalid' });
    }

    const user = await User.findById(decoded.id).select('name email tokenVersion createdAt');
    if (!user) {
      return res.status(401).json({ message: 'Not authorised user no longer exists' });
    }

    const tokenVersionInToken = Number(decoded.v) || 0;
    const tokenVersionInUser = Number(user.tokenVersion) || 0;
    if (tokenVersionInToken !== tokenVersionInUser) {
      return res.status(401).json({ message: 'Not authorised token revoked' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error.message);
    res.status(500).json({ message: 'Server error during authentication' });
  }
};

module.exports = protect;
