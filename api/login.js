// api/login.js — autenticação com senha + JWT de 8h
//
// Variáveis de ambiente obrigatórias:
//   APP_PASSWORD_HASH  — hash bcrypt da senha (gere com: npm run hash)
//   JWT_SECRET         — segredo para assinar tokens (gere com: openssl rand -hex 32)

'use strict';

const bcrypt = require('bcryptjs');
const { criarJWT } = require('./_auth');

// Rate limiting específico para login: janela maior e limite menor
const tentativas = new Map();
const MAX_TENTATIVAS = 5;
const JANELA_MS = 15 * 60 * 1000; // 15 minutos

function limitarLogin(ip) {
  const now = Date.now();
  let e = tentativas.get(ip);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + JANELA_MS };
  e.count++;
  tentativas.set(ip, e);
  return e.count <= MAX_TENTATIVAS;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const ip = ((req.headers['x-forwarded-for'] || '') || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();

  if (!limitarLogin(ip)) {
    return res.status(429).json({
      error: 'Muitas tentativas de login. Aguarde 15 minutos.',
    });
  }

  const { senha } = req.body || {};
  if (!senha || typeof senha !== 'string' || !senha.trim()) {
    return res.status(400).json({ error: 'Senha obrigatória.' });
  }

  const hashArmazenado = process.env.APP_PASSWORD_HASH;
  const jwtSecret     = process.env.JWT_SECRET;

  if (!hashArmazenado || !jwtSecret) {
    return res.status(503).json({
      error: 'Servidor não configurado. Defina APP_PASSWORD_HASH e JWT_SECRET no Vercel.',
    });
  }

  const senhaValida = await bcrypt.compare(senha, hashArmazenado);
  if (!senhaValida) {
    // Mesma mensagem independente do motivo — não revelar se o hash existe
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  // Senha correta — emitir JWT de 8 horas
  const agora = Math.floor(Date.now() / 1000);
  const payload = {
    // Fase E: sub e papel virão da tabela de usuários
    sub:   'usuario',
    papel: 'secretaria',
    iat:   agora,
    exp:   agora + 8 * 3600,
  };

  return res.status(200).json({ token: criarJWT(payload, jwtSecret) });
};
