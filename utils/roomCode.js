'use strict';

const ROOM_CODE_REGEX = /^[A-Z0-9]{6}$/;
const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_CHARSET[Math.floor(Math.random() * ROOM_CODE_CHARSET.length)];
  }
  return code;
}

function normalizeRoomCode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().toUpperCase();
  if (!ROOM_CODE_REGEX.test(trimmed)) return null;
  return trimmed;
}

module.exports = {
  ROOM_CODE_REGEX,
  ROOM_CODE_CHARSET,
  generateRoomCode,
  normalizeRoomCode,
};
