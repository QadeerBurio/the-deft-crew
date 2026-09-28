// backend/services/engagement/rewardCodes.js
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1

function generateCode(prefix = 'TDC') {
  const rand = (len) =>
    Array.from({ length: len }, () =>
      ALPHABET[crypto.randomInt(0, ALPHABET.length)]
    ).join('');
  return `${prefix}-${rand(4)}-${rand(4)}`;
}

module.exports = { generateCode };