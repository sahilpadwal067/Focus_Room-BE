'use strict';

const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    });
    console.log(`MongoDB connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    // Sanitize error message to avoid logging raw connection strings with credentials
    const safeMsg = error.message
      ? error.message.replace(/mongodb(\+srv)?:\/\/[^@]+@/, 'mongodb://***:***@')
      : 'Connection failed';
    console.error(`MongoDB connection error: ${safeMsg}`);
    process.exit(1);
  }
};

module.exports = connectDB;
