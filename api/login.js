'use strict';
// api/login.js — autenticação exclusivamente via banco de dados (Fase E)
// Sem DATABASE_URL = sem login. Não há caminho paralelo de autenticação.

const bcrypt = require('bcryptjs');
const { criarJWT, applyCors } = require('./_auth');
const { getPool }             = require('./_db');

const tentativas = new Map();
const MAX = 5, JANELA = 15 * 60 * 1000;

function limitarLogin(ip) {
  const now = Date.now();
  let e = tentativas.get(ip);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + JANELA };
  e.count++;
  tentativas.set(ip, e);
  return e.count <= MAX;
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método não permitido.' });

  const ip = ((req.headers['x-forwarded-for'] || '') || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();
  if (!limitarLogin(ip))
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret)
    return res.status(503).json({ error: 'JWT_SECRET não configurado no servidor.' });

  const pool = getPool();
  if (!pool)
    return res.status(503).json({
      error: 'Banco de dados não configurado. Defina DATABASE_URL e crie um usuário com npm run db:criar-admin.',
    });

  const { email, senha } = req.body || {};
  if (!senha || typeof senha !== 'string' || !senha.trim())
    return res.status(400).json({ error: 'Senha obrigatória.' });
  if (!email || typeof email !== 'string' || !email.includes('@'))
    return res.status(400).json({ error: 'E-mail obrigatório.' });

  let usuario;
  try {
    const { rows } = await pool.query(
      'SELECT id, hash_senha, papel, ativo FROM usuarios WHERE email = $1',
      [email.trim().toLowerCase()]
    );
    usuario = rows[0];
  } catch {
    return res.status(503).json({ error: 'Banco indisponível. Tente novamente.' });
  }

  // Hash de referência constante para evitar timing oracle quando usuário não existe
  const hashRef = usuario?.hash_senha || '$2a$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.';
  const ok = await bcrypt.compare(senha, hashRef);

  if (!ok || !usuario) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  if (!usuario.ativo)  return res.status(401).json({ error: 'Conta desativada. Contate o administrador.' });

  pool.query('UPDATE usuarios SET ultimo_acesso = NOW() WHERE id = $1', [usuario.id]).catch(() => {});

  const agora = Math.floor(Date.now() / 1000);
  return res.status(200).json({
    token: criarJWT({
      sub: usuario.id, email: email.trim().toLowerCase(),
      papel: usuario.papel, iat: agora, exp: agora + 8 * 3600,
    }, jwtSecret),
  });
};
