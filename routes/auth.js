'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const protect = require('../middleware/auth');

const router = express.Router();

const generateToken = (userId, tokenVersion = 0) => {
  return jwt.sign({ id: userId, v: Number(tokenVersion) || 0 }, process.env.JWT_SECRET, {
    expiresIn: '15m',
  });
};

const safeUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  createdAt: user.createdAt,
});

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ message: 'Name must be at least 2 characters' });
    }
    if (name.trim().length > 50) {
      return res.status(400).json({ message: 'Name cannot exceed 50 characters' });
    }
    if (!email || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim()) || email.trim().length > 254) {
      return res.status(400).json({ message: 'Please enter a valid email' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }
    if (password.length > 128) {
      return res.status(400).json({ message: 'Password cannot exceed 128 characters' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ message: 'An account with that email already exists' });
    }

    const user = await User.create({ name: name.trim(), email: normalizedEmail, password });
    const token = generateToken(user._id, user.tokenVersion);

    res.status(201).json({ user: safeUser(user), token, expiresInMinutes: 15 });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ message: messages[0] });
    }
    if (error.code === 11000 && error.keyPattern && error.keyPattern.email) {
      return res.status(409).json({ message: 'An account with that email already exists' });
    }
    console.error('Register error:', error.message);
    res.status(500).json({ message: 'Server error during registration' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = generateToken(user._id, user.tokenVersion);
    res.json({ user: safeUser(user), token, expiresInMinutes: 15 });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ message: 'Server error during login' });
  }
});

router.post('/logout', protect, async (req, res) => {
  try {
    await User.findByIdAndUpdate(
      req.user._id,
      { $inc: { tokenVersion: 1 } },
      { runValidators: true }
    );
    res.json({ message: 'Logged out' });
  } catch (error) {
    console.error('Logout error:', error.message);
    res.status(500).json({ message: 'Server error during logout' });
  }
});

router.get('/me', protect, (req, res) => {
  res.json({ user: safeUser(req.user) });
});

module.exports = router;
