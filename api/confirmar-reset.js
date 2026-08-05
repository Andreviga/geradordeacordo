'use strict';
// POST /api/confirmar-reset  {token, novaSenha}
// Valida token, atualiza senha e devolve JWT para login automático.
const bcrypt = require('bcryptjs');
const { getPool } = require('./_db');
const { criarJWT } = require('./_auth');

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
