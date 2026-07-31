// api/_auth.js — utilitários JWT para as funções serverless
// JWT HS256 com Node.js crypto nativo — sem dependências externas.
//
// ── Design da tabela de usuários (Fase E) ──────────────────────────────────
// Quando o banco de dados for adicionado na Fase E, esta tabela substituirá
// a senha única compartilhada de APP_PASSWORD_HASH:
//
//   CREATE TABLE usuarios (
//     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//     nome          TEXT NOT NULL,
//     email         TEXT UNIQUE NOT NULL,
//     hash_senha    TEXT NOT NULL,     -- bcrypt, custo 12
//     papel         TEXT NOT NULL DEFAULT 'secretaria',
//                                      -- 'admin' | 'secretaria' | 'leitura'
//     ativo         BOOLEAN NOT NULL DEFAULT true,
//     criado_em     TIMESTAMPTZ DEFAULT NOW(),
//     ultimo_acesso TIMESTAMPTZ
//   );
//
// Na Fase E, o payload do JWT passará a incluir:
//   { sub: usuario.id, email: usuario.email, papel: usuario.papel, ... }

'use strict';
const crypto = require('crypto');

function b64url(data) {
  return Buffer.from(data).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Gera um JWT HS256 assinado com `secret`.
 * @param {object} payload  – deve conter `exp` (epoch seconds)
 * @param {string} secret
 */
function criarJWT(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

/**
 * Verifica e decodifica um JWT HS256.
 * @returns {object|null} payload se válido e não expirado, null caso contrário
 */
function verificarJWT(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;
    const expected = b64url(
      crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest()
    );
    // Buffers devem ter o mesmo tamanho antes de timingSafeEqual
    const bufSig = Buffer.from(sig);
    const bufExp = Buffer.from(expected);
    if (bufSig.length !== bufExp.length) return null;
    // Comparação em tempo constante — previne timing attacks
    if (!crypto.timingSafeEqual(bufSig, bufExp)) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Extrai e verifica JWT do header `Authorization: Bearer <token>`.
 * Se inválido, responde 401 (ou 500 se JWT_SECRET não configurado) e retorna null.
 * Retorna o payload se válido.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {object|null}
 */
function verificarRequisicao(req, res) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'JWT_SECRET não configurado no servidor.' });
    return null;
  }
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Autenticação necessária. Faça login novamente.' });
    return null;
  }
  const payload = verificarJWT(auth.slice(7), secret);
  if (!payload) {
    res.status(401).json({ error: 'Sessão expirada ou inválida. Faça login novamente.' });
    return null;
  }
  return payload;
}

module.exports = { criarJWT, verificarJWT, verificarRequisicao };
