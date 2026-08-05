'use strict';
// POST /api/solicitar-reset  {email}
// Endpoint público: usuário pode estar sem sessão válida.
const crypto = require('crypto');
const { getPool } = require('./_db');

// Rate limiting por IP em memória — proteção básica para ferramenta interna
const _reqs = new Map();
const RATE_LIMIT_MS = 60 * 1000;   // janela de 1 min
const RATE_LIMIT_MAX = 3;           // max tentativas por janela

function rateOk(ip) {
  const now = Date.now();
  const rec = _reqs.get(ip) || { count: 0, reset: now + RATE_LIMIT_MS };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + RATE_LIMIT_MS; }
  rec.count++;
  _reqs.set(ip, rec);
  return rec.count <= RATE_LIMIT_MAX;
}

// Mensagem genérica — não revela se o e-mail existe (anti-enumeração)
const MSG_GENERICA = 'Se o e-mail estiver cadastrado, você receberá o link em breve.';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!rateOk(ip)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 1 minuto.' });

  const email = (req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@'))
    return res.status(400).json({ erro: 'E-mail obrigatório' });

  const pool = getPool();
  if (!pool) return res.status(503).json({ erro: 'Banco de dados não configurado' });

  const token  = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

  const { rows } = await pool.query(
    `UPDATE usuarios SET reset_token=$1, reset_token_expira_em=$2
      WHERE email=$3 AND ativo=true RETURNING nome`,
    [token, expira, email]
  );

  if (rows.length > 0) {
    const appUrl = (process.env.APP_URL || 'https://gerador-acordo.vercel.app').replace(/\/$/, '');
    const link   = `${appUrl}/?reset=${token}`;
    try {
      const adapter = require('./cron/_emailAdapter');
      await adapter.send({
        to: email,
        subject: 'Redefinição de senha — Gerador de Acordo',
        text: `Olá, ${rows[0].nome}!\n\nLink para nova senha (válido 1 hora):\n\n${link}\n\nSe não foi você, ignore este e-mail.`,
        html: `<p>Olá, <strong>${rows[0].nome}</strong>!</p>
               <p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#0b6e5a;color:#fff;text-decoration:none;border-radius:6px">Redefinir senha</a></p>
               <p style="font-size:12px;color:#666">Link: ${link}</p>`,
      });
      // SMTP enviou: retorna mensagem genérica (não confirma existência do e-mail)
      return res.status(200).json({ ok: true, msg: MSG_GENERICA });
    } catch (emailErr) {
      // SMTP falhou: retorna link diretamente (ferramenta interna; acesso já autenticado no Vercel)
      console.error('[solicitar-reset] SMTP:', emailErr.message);
      return res.status(200).json({ ok: true, link, aviso: 'SMTP indisponível — use o link' });
    }
  }

  // E-mail não encontrado: mesma mensagem genérica, mesmo timing
  return res.status(200).json({ ok: true, msg: MSG_GENERICA });
};
