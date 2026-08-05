'use strict';
// POST /api/solicitar-reset  {email}
const crypto  = require('crypto');
const { Pool } = require('pg');

function conectar() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('channel_binding');
    return new Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, max: 2 });
  } catch { return new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 }); }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Metodo nao permitido' });

  const email = (req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@'))
    return res.status(400).json({ erro: 'E-mail obrigatorio' });

  const pool = conectar();
  if (!pool) return res.status(503).json({ erro: 'DATABASE_URL nao configurado' });

  try {
    await pool.query(
      'ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token TEXT;' +
      'ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token_expira_em TIMESTAMPTZ;'
    ).catch(() => {});

    const token  = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + 60 * 60 * 1000);

    const { rows } = await pool.query(
      'UPDATE usuarios SET reset_token=$1, reset_token_expira_em=$2 WHERE email=$3 AND ativo=true RETURNING nome',
      [token, expira, email]
    );

    if (rows.length > 0) {
      const appUrl = (process.env.APP_URL || 'https://gerador-acordo.vercel.app').replace(/\/$/, '');
      const link   = appUrl + '/?reset=' + token;
      try {
        const adapter = require('./cron/_emailAdapter');
        await adapter.send({ to: email, subject: 'Redefinicao de senha', text: 'Link: ' + link });
        return res.status(200).json({ ok: true, msg: 'Link enviado! Verifique seu e-mail.' });
      } catch (emailErr) {
        console.error('[solicitar-reset] SMTP:', emailErr.message);
        return res.status(200).json({ ok: true, link: link, aviso: 'SMTP indisponivel' });
      }
    }
    return res.status(200).json({ ok: true, msg: 'Se o e-mail estiver cadastrado, voce recebera o link.' });
  } finally {
    pool.end().catch(() => {});
  }
};
