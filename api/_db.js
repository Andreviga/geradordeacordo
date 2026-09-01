'use strict';
const { Pool } = require('pg');

let _pool = null;

function _validateUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url.startsWith('postgresql://') && !url.startsWith('postgres://'))
    throw new Error(
      `DATABASE_URL inválida: esperado "postgresql://..." mas recebeu "${url.substring(0, 40)}..."\n` +
      'Verifique a variável de ambiente no Vercel — ela deve conter só a connection string, ' +
      'sem prefixo "psql" ou outros comandos.'
    );
  return url;
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

// O Neon hiberna quando fica ocioso. A primeira conexão depois disso acorda o
// banco e estoura o connectionTimeoutMillis; a seguinte conecta em ~1s. Medido em
// produção: 1ª tentativa 503 em 5s, 2ª respondeu em 1,1s. Sem isto, quem abre o
// sistema de manhã leva "Banco indisponível" e precisa clicar em Entrar de novo.
//
// Só repete quando a conexão NÃO chegou a ser aberta — aí é certo que o comando
// não rodou, e repetir é seguro mesmo para INSERT. Erro no meio da consulta
// (conexão derrubada) não entra aqui: repetir poderia gravar duas vezes.
function ehFalhaAoConectar(err) {
  const m = err?.message || '';
  return err?.code === 'ECONNREFUSED'
      || err?.code === 'ENOTFOUND'
      || err?.code === 'ETIMEDOUT'
      || m.includes('timeout exceeded when trying to connect')
      || m.includes('Connection terminated due to connection timeout');
}

async function _comRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!ehFalhaAoConectar(err)) throw err;
    await new Promise(r => setTimeout(r, 300));
    return fn();
  }
}

function getPool() {
  if (!_pool && process.env.DATABASE_URL) {
    const url = _validateUrl(process.env.DATABASE_URL);
    _pool = new Pool({
      connectionString: _cleanUrl(url),
      ssl: _ssl(url),
      max: 3,                     // Vercel functions: pool pequeno
      idleTimeoutMillis: 15000,
      connectionTimeoutMillis: 5000,
    });
    // 5s + 300ms + ~1s de reconexão cabe folgado no limite de execução da função
    const queryOriginal = _pool.query.bind(_pool);
    _pool.query = (...args) => _comRetry(() => queryOriginal(...args));
    const connectOriginal = _pool.connect.bind(_pool);
    _pool.connect = (...args) => _comRetry(() => connectOriginal(...args));
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

module.exports = { getPool, withTransaction, isDbUnavailable, ehFalhaAoConectar };
