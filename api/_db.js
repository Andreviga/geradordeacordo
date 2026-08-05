'use strict';
const { Pool } = require('pg');

let _pool = null;

function _extractUrl(raw) {
  // Suporta DATABASE_URL colada como comando psql: psql 'postgresql://...'
  const m = (raw || '').trim().match(/psql\s+['"]?(postgresql:\/\/.+?)['"]?\s*$/i);
  return m ? m[1] : (raw || '');
}

function _ssl(url) {
  try {
    const local = ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
    return local ? false : { rejectUnauthorized: true };
  } catch { return false; }
}

function _cleanUrl(url) {
  // Remove parâmetros não suportados pelo driver pg (sslmode, channel_binding)
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('channel_binding');
    return u.toString();
  } catch { return url; }
}

function getPool() {
  if (!_pool && process.env.DATABASE_URL) {
    const url = _extractUrl(process.env.DATABASE_URL);
    _pool = new Pool({
      connectionString: _cleanUrl(url),
      ssl: _ssl(url),
      max: 3,                     // Vercel functions: pool pequeno
      idleTimeoutMillis: 15000,
      connectionTimeoutMillis: 5000,
    });
  }
  return _pool;
}

async function withTransaction(fn) {
  const pool = getPool();
  if (!pool) throw Object.assign(new Error('DATABASE_URL não configurado'), { code: 'DB_NOT_CONFIGURED' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

// Converte erro de conexão pg em código legível para os handlers
function isDbUnavailable(err) {
  const m = err?.message || '';
  return (
    err?.code === 'DB_NOT_CONFIGURED' ||
    err?.code === 'ECONNREFUSED'       ||
    err?.code === 'ETIMEDOUT'          ||
    err?.code === 'ENOTFOUND'          ||
    err?.code === '57P01'              || // admin_shutdown
    err?.code === '08006'              || // connection_failure
    m.includes('Connection terminated')  ||
    m.includes('Client was closed')
  );
}

module.exports = { getPool, withTransaction, isDbUnavailable };
