'use strict';
const crypto  = require('crypto');
const { Pool } = require('pg');
const { criarJWT } = require('./_auth');

// Parseia DATABASE_URL para parametros individuais que sobrescrevem env vars PG*
function parseDbUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      host:     u.hostname,
      port:     parseInt(u.port || '5432', 10),
      user:     decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
      ssl:      { rejectUnauthorized: false },
      max: 2,
    };
  } catch {
    // keyword format fallback
    return { connectionString: raw, ssl: { rejectUnauthorized: false }, max: 2 };
  }
}

// POST /api/solicitar-reset  {email}
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Metodo nao permitido' });

  const email = (req.body && req.body.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') < 0)
    return res.status(400).json({ erro: 'E-mail obrigatorio' });

  const cfg = parseDbUrl(process.env.DATABASE_URL);
  if (!cfg) return res.status(503).json({ erro: 'DATABASE_URL nao configurado' });

  const pool = new Pool(cfg);
  try {
    await pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token TEXT').catch(function(){});
    await pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token_expira_em TIMESTAMPTZ').catch(function(){});

    var token  = crypto.randomBytes(32).toString('hex');
    var expira = new Date(Date.now() + 60 * 60 * 1000);

    var r = await pool.query(
      'UPDATE usuarios SET reset_token=$1, reset_token_expira_em=$2 WHERE email=$3 AND ativo=true RETURNING nome',
      [token, expira, email]
    );

    if (r.rows.length > 0) {
      var appUrl = (process.env.APP_URL || 'https://gerador-acordo.vercel.app').replace(/\/$/, '');
      var link   = appUrl + '/?reset=' + token;
      try {
        var adapter = require('./cron/_emailAdapter');
        await adapter.send({ to: email, subject: 'Redefinicao de senha', text: 'Link: ' + link });
        return res.status(200).json({ ok: true, msg: 'Link enviado! Verifique seu e-mail.' });
      } catch (emailErr) {
        console.error('[solicitar-reset] SMTP:', emailErr.message);
        return res.status(200).json({ ok: true, link: link, aviso: 'SMTP indisponivel' });
      }
    }
    return res.status(200).json({ ok: true, msg: 'Se o e-mail estiver cadastrado, voce recebera o link.' });
  } finally {
    pool.end().catch(function(){});
  }
};
