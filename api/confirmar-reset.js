'use strict';
// POST /api/confirmar-reset  {token, novaSenha}
const bcrypt  = require('bcryptjs');
const { Pool } = require('pg');
const { criarJWT } = require('./_auth');

// Parseia DATABASE_URL — suporta "psql 'postgresql://...'" ou URL direta
function conectar() {
  var raw = process.env.DATABASE_URL || '';
  if (!raw) return null;
  var url = raw.trim();
  var m = url.match(/psql\s+['"]?(postgresql:\/\/.+?)['"]?\s*$/i);
  if (m) url = m[1]; // extrai URL do wrapper psql
  try {
    const u = new URL(url);
    return new Pool({ host: u.hostname, port: parseInt(u.port||'5432',10),
      user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//,''), ssl:{rejectUnauthorized:false}, max:2 });
  } catch { return new Pool({ connectionString: url, ssl:{rejectUnauthorized:false}, max:2 }); }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { token, novaSenha } = req.body || {};
  if (!token)                             return res.status(400).json({ erro: 'Token obrigatório' });
  if (!novaSenha || novaSenha.length < 8) return res.status(400).json({ erro: 'Senha deve ter pelo menos 8 caracteres' });

  const pool = conectar();
  if (!pool) return res.status(503).json({ erro: 'DATABASE_URL não configurado' });

  try {
    const { rows } = await pool.query(
      `SELECT id, nome, email, papel FROM usuarios
        WHERE reset_token=$1 AND reset_token_expira_em>NOW() AND ativo=true`,
      [token]
    );

    if (!rows.length)
      return res.status(400).json({ erro: 'Link inválido ou expirado. Solicite um novo.' });

    const u = rows[0];
    const hash = await bcrypt.hash(novaSenha, 10);

    await pool.query(
      `UPDATE usuarios SET hash_senha=$1, reset_token=NULL, reset_token_expira_em=NULL, ultimo_acesso=NOW()
        WHERE id=$2`,
      [hash, u.id]
    );

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(503).json({ erro: 'JWT_SECRET não configurado' });

    const exp      = Math.floor(Date.now() / 1000) + 8 * 3600;
    const jwtToken = criarJWT({ sub: u.id, email: u.email, papel: u.papel, exp }, secret);

    return res.status(200).json({ ok: true, token: jwtToken, nome: u.nome });
  } finally {
    pool.end().catch(() => {});
  }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { token, novaSenha } = req.body || {};
  if (!token)                            return res.status(400).json({ erro: 'Token obrigatório' });
  if (!novaSenha || novaSenha.length < 8) return res.status(400).json({ erro: 'Senha deve ter pelo menos 8 caracteres' });

  const pool = getPool();
  if (!pool) return res.status(503).json({ erro: 'Banco indisponível' });

  const { rows } = await pool.query(
    `SELECT id, nome, email, papel
       FROM usuarios
      WHERE reset_token = $1
        AND reset_token_expira_em > NOW()
        AND ativo = true`,
    [token]
  );

  if (!rows.length)
    return res.status(400).json({ erro: 'Link inválido ou expirado. Solicite um novo.' });

  const u = rows[0];
  const hash = await bcrypt.hash(novaSenha, 10);

  await pool.query(
    `UPDATE usuarios
        SET hash_senha = $1, reset_token = NULL, reset_token_expira_em = NULL, ultimo_acesso = NOW()
      WHERE id = $2`,
    [hash, u.id]
  );

  // Emite JWT para login automático após a troca de senha
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(503).json({ erro: 'JWT_SECRET não configurado' });

  const exp = Math.floor(Date.now() / 1000) + 8 * 3600;
  const jwtToken = criarJWT({ sub: u.id, email: u.email, papel: u.papel, exp }, secret);

  return res.status(200).json({ ok: true, token: jwtToken, nome: u.nome });
};
