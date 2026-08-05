'use strict';
// POST /api/solicitar-reset  {email}
// Gera token de 1h, salva no banco e envia link por e-mail.
// Sempre retorna 200 (não revela se o e-mail existe).
const crypto = require('crypto');
const { getPool } = require('./_db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const email = (req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@'))
    return res.status(400).json({ erro: 'E-mail obrigatório' });

  const pool = getPool();
  if (!pool) return res.status(503).json({ erro: 'Banco indisponível' });

  // Gera token e persiste — silencia se e-mail não existe (não revela cadastro)
  const token  = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

  const { rows } = await pool.query(
    `UPDATE usuarios
        SET reset_token = $1, reset_token_expira_em = $2
      WHERE email = $3 AND ativo = true
      RETURNING nome`,
    [token, expira, email]
  );

  if (rows.length > 0) {
    // Envia e-mail apenas se SMTP estiver configurado
    try {
      const adapter = require('./cron/_emailAdapter');
      const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : (process.env.APP_URL || 'https://gerador-acordo.vercel.app');
      const link = `${base}/?reset=${token}`;
      await adapter.send({
        to: email,
        subject: 'Redefinição de senha — Gerador de Acordo',
        text: `Olá, ${rows[0].nome}!\n\nClique no link abaixo para criar uma nova senha (válido por 1 hora):\n\n${link}\n\nSe não foi você, ignore este e-mail.`,
        html: `<p>Olá, <strong>${rows[0].nome}</strong>!</p>
               <p>Clique no botão abaixo para criar uma nova senha (válido por <strong>1 hora</strong>):</p>
               <p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#0b6e5a;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">Redefinir senha</a></p>
               <p style="font-size:12px;color:#666">Ou copie o link: ${link}</p>
               <p style="font-size:12px;color:#666">Se não foi você, ignore este e-mail.</p>`,
      });
    } catch (err) {
      // SMTP não configurado ou falhou — retorna o token para reset local
      if (process.env.NODE_ENV !== 'production')
        return res.status(200).json({ aviso: 'SMTP não configurado', token, link: `/?reset=${token}` });
      console.error('[solicitar-reset] SMTP falhou:', err.message);
    }
  }

  return res.status(200).json({ ok: true, msg: 'Se o e-mail estiver cadastrado, você receberá as instruções em breve.' });
};
