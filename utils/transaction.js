// utils/transaction.js
// withTransaction(work): runs work(session) inside a MongoDB transaction when the server supports one
// (Atlas replica sets do), otherwise runs work(null) without one. Returns { transaction, result }.
// Moved from services/accountDeletion.js so other modules (loyalty) can use it.
const mongoose = require("mongoose");

const noTransactions = (err) =>
  err && (err.code === 20 || err.codeName === "IllegalOperation" || /Transaction numbers are only allowed|replica set|does not support (sessions|transactions)/i.test(err.message || ""));

async function withTransaction(work) {
  const conn = mongoose.connection;
  if (conn.readyState !== 1) return { transaction: false, result: await work(null) };
  try {
    let result;
    await conn.transaction(async (session) => {
      result = await work(session);
    });
    return { transaction: true, result };
  } catch (err) {
    if (!noTransactions(err)) throw err;
    return { transaction: false, result: await work(null) };
  }
}

module.exports = { withTransaction, noTransactions };
