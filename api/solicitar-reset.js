'use strict';
// POST /api/solicitar-reset  {email}
const crypto  = require('crypto');
const { Pool } = require('pg');

// Pool local para evitar conflitos com o singleton de _db.js
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
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const email = (req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@'))
    return res.status(400).json({ erro: 'E-mail obrigatório' });

  const pool = conectar();
  if (!pool) return res.status(503).json({ erro: 'DATABASE_URL não configurado' });

  try {
    // Garante que as colunas existem (idempotente)
    await pool.query(
      'ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token TEXT;' +
      'ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token_expira_em TIMESTAMPTZ;'
    ).catch(() => {});

    const token  = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + 60 * 60 * 1000);

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
          text: `Olá, ${rows[0].nome}!\n\nLink para nova senha (válido 1 hora):\n\n${link}`,
          html: `<p>Olá, <strong>${rows[0].nome}</strong>!</p>
                 <p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#0b6e5a;color:#fff;text-decoration:none;border-radius:6px">Redefinir senha</a></p>
                 <p style="font-size:12px;color:#666">Link: ${link}</p>`,
        });
        return res.status(200).json({ ok: true, msg: 'Link enviado! Verifique seu e-mail.' });
      } catch (emailErr) {
        console.error('[solicitar-reset] SMTP:', emailErr.message);
        return res.status(200).json({ ok: true, link, aviso: 'SMTP indisponível — use este link' });
      }
    }
    return res.status(200).json({ ok: true, msg: 'Se o e-mail estiver cadastrado, você receberá o link em breve.' });
  } finally {
    pool.end().catch(() => {});
  }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const email = (req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@'))
    return res.status(400).json({ erro: 'E-mail obrigatório' });

  const pool = getPool();
  const dbHost = (process.env.DATABASE_URL || '').split('@')[1]?.split('/')[0] || '(DATABASE_URL não definido)';
  console.error('[solicitar-reset] db-host:', dbHost, '| pool:', !!pool);
  if (!pool) return res.status(503).json({ erro: 'Banco indisponível', dbHost });

  // Garante que as colunas existem (idempotente — migração inline)
  await pool.query(
    'ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token TEXT;' +
    'ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token_expira_em TIMESTAMPTZ;'
  ).catch(() => {}); // ignora se já existirem ou sem permissão

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
    const base = process.env.APP_URL || 'https://gerador-acordo.vercel.app';
    const link = `${base}/?reset=${token}`;
    try {
      const adapter = require('./cron/_emailAdapter');
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
      // E-mail enviado com sucesso
      return res.status(200).json({ ok: true, msg: 'Verifique seu e-mail! O link é válido por 1 hora.' });
    } catch (err) {
      // SMTP não configurado ou falhou — retorna o link diretamente (ferramenta interna)
      console.error('[solicitar-reset] SMTP:', err.message);
      return res.status(200).json({ ok: true, link, aviso: 'SMTP não configurado — use o link abaixo' });
    }
  }

  return res.status(200).json({ ok: true, msg: 'Se o e-mail estiver cadastrado, você receberá as instruções em breve.' });
};
