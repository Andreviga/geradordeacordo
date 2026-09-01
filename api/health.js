'use strict';
// api/health.js  →  GET /api/health
// Requer JWT de admin — nunca expõe dados sem autenticação.
// Roda no ambiente Vercel com as variáveis reais, diferente do script local.

const { verificarRequisicaoComBanco, applyCors } = require('./_auth');
const { getPool }                                = require('./_db');

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ erro: 'Método não permitido' });

  const user = await verificarRequisicaoComBanco(req, res);
  if (!user) return;
  if (user.papel !== 'admin')
    return res.status(403).json({ erro: 'Apenas administradores podem acessar /api/health' });

  // Identificar o banco sem expor credenciais
  const rawUrl = process.env.DATABASE_URL || '';
  let banco = 'não configurado';
  try { const u = new URL(rawUrl); banco = `${u.hostname}${u.pathname}`; } catch {}

  const resultado = {
    ts:    new Date().toISOString(),
    banco,
    build: buildInfo(),      // commit hash e ambiente — sem isso não dá para saber se é o código certo
    ok:    true,
    vars:  {},
    db:    {},
    drive: { ok: null, msg: 'não configurado' },
    smtp:  { ok: null, msg: 'não configurado (Etapa 5)' },
  };

  // ── Variáveis de ambiente ────────────────────────────────────────────────
  // Inventário completo do que o código lê. Toda variável nova precisa aparecer
  // aqui — tests/env-health.test.js falha se alguma ficar de fora. A regra existe
  // porque DRIVE_BACKUP_FOLDER_ID faltou no painel e o backup semanal abortava em
  // silêncio: sem estar no health, não havia como perceber.
  resultado.vars = {
    JWT_SECRET:     !!process.env.JWT_SECRET,
    DATABASE_URL:   !!process.env.DATABASE_URL,
    ALLOWED_ORIGIN: !!process.env.ALLOWED_ORIGIN,
    CRON_SECRET:    !!process.env.CRON_SECRET,
    ASSINATURA:     'gov.br',
    GOOGLE_DRIVE:   !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    DRIVE_FOLDER:   !!process.env.DRIVE_PDF_FOLDER_ID,
    DRIVE_BACKUP_FOLDER_ID: !!process.env.DRIVE_BACKUP_FOLDER_ID,
    SMTP:           !!(process.env.SMTP_USER && process.env.SMTP_PASS),
    EMAIL_FROM:     !!process.env.EMAIL_FROM,
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER || '(padrão)',
    CONTATO_SECRETARIA_EMAIL: !!process.env.CONTATO_SECRETARIA_EMAIL,
    CONTATO_SECRETARIA_FONE:  !!process.env.CONTATO_SECRETARIA_FONE,
    // Opcionais, com padrão no código
    APP_URL:                    process.env.APP_URL                    || '(padrão)',
    RETENCAO_ANOS:              process.env.RETENCAO_ANOS              || '(padrão: 5)',
    LEMBRETES_MAX_POR_EXECUCAO: process.env.LEMBRETES_MAX_POR_EXECUCAO || '(padrão: 5)',
    // Variáveis que devem ter sido removidas
    APP_PASSWORD_HASH_presente: !!process.env.APP_PASSWORD_HASH,
    ADOBE_presente:             !!(process.env.ADOBE_SIGN_INTEGRATION_KEY || process.env.ADOBE_SIGN_REGION),
    ZAPSIGN_presente:           !!(process.env.ZAPSIGN_API_TOKEN || process.env.ZAPSIGN_WEBHOOK_SECRET),
  };

  if (!resultado.vars.JWT_SECRET || !resultado.vars.DATABASE_URL)
    resultado.ok = false;

  // O backup semanal aborta sem a pasta de destino. Falha silenciosa: o cron
  // levanta, erra e ninguém fica sabendo — então o health precisa gritar.
  if (resultado.vars.GOOGLE_DRIVE && !resultado.vars.DRIVE_BACKUP_FOLDER_ID) {
    resultado.ok = false;
    resultado.avisos = [...(resultado.avisos || []),
      'DRIVE_BACKUP_FOLDER_ID ausente — o backup semanal falha a cada execução.'];
  }
  if (!resultado.vars.CRON_SECRET) {
    resultado.ok = false;
    resultado.avisos = [...(resultado.avisos || []),
      'CRON_SECRET ausente — lembretes e backup respondem 401 e nunca rodam.'];
  }

  // ── Banco de dados ───────────────────────────────────────────────────────
  const pool = getPool();
  if (!pool) {
    resultado.db  = { ok: false, msg: 'DATABASE_URL não configurado' };
    resultado.ok  = false;
  } else {
    const client = await pool.connect();
    try {
      // Contar tabelas do schema
      const { rows: tbl } = await client.query(
        `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`
      );
      const nTbl = parseInt(tbl[0].n, 10);

      // Usuários ativos
      const { rows: usr } = await client.query(
        `SELECT COUNT(*) AS n FROM usuarios WHERE ativo=true`
      );
      const nUsr = parseInt(usr[0].n, 10);

      // Última sequência
      const { rows: seq } = await client.query(
        `SELECT ano, ultimo FROM acordo_numero_seq ORDER BY ano DESC LIMIT 2`
      );

      // Verificar schema mínimo
      const schemaOk = nTbl >= 13;
      resultado.db = {
        ok:              schemaOk && nUsr > 0,
        tabelas:         nTbl,
        usuarios_ativos: nUsr,
        sequencia:       seq.map(r => `${r.ano}/${r.ultimo}`),
        msg:             !schemaOk  ? `Schema incompleto (${nTbl}/13 tabelas) — execute db:migrate`
                       : nUsr === 0 ? 'Nenhum usuário ativo — execute db:criar-admin'
                       : `OK`,
      };
      if (!resultado.db.ok) resultado.ok = false;
    } finally {
      client.release();
    }
  }

  // ── Drive ────────────────────────────────────────────────────────────────
  const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (saRaw) {
    try {
      const text = saRaw.startsWith('{') ? saRaw : Buffer.from(saRaw, 'base64').toString('utf8');
      const sa   = JSON.parse(text);
      if (!sa.private_key || !sa.client_email) throw new Error('campos ausentes');

      // Obter token para verificação
      const crypto = require('crypto');
      const now    = Math.floor(Date.now() / 1000);
      const hdr    = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const pay    = Buffer.from(JSON.stringify({
        iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive',
        aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
      })).toString('base64url');
      const sig = crypto.createSign('RSA-SHA256').update(`${hdr}.${pay}`).sign(sa.private_key, 'base64url');
      const jwt = `${hdr}.${pay}.${sig}`;

      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error_description || d.error);

      // Emitir o token NÃO prova que o Drive funciona: ele é emitido pelo
      // oauth2.googleapis.com, que responde mesmo com a Drive API desativada no
      // projeto. Foi exatamente esse falso-verde que deixou o backup falhar com
      // 403 "Drive API has not been used in project" enquanto o health dizia
      // "Credencial válida". Agora consulta as pastas de verdade.
      const pastas = {
        DRIVE_PDF_FOLDER_ID:    process.env.DRIVE_PDF_FOLDER_ID,
        DRIVE_BACKUP_FOLDER_ID: process.env.DRIVE_BACKUP_FOLDER_ID,
      };
      const acesso = {};
      let algumProblema = null;

      for (const [nome, id] of Object.entries(pastas)) {
        if (!id) { acesso[nome] = 'não configurada'; continue; }
        const u = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`
                + '?fields=id,name,mimeType&supportsAllDrives=true';
        const rp = await fetch(u, { headers: { Authorization: `Bearer ${d.access_token}` } });
        if (rp.ok) {
          const meta = await rp.json();
          acesso[nome] = `ok — "${meta.name}"`;
          continue;
        }
        const corpo = await rp.text();
        if (/has not been used in project|is disabled/i.test(corpo)) {
          acesso[nome] = 'Drive API desativada no projeto GCP';
          algumProblema = 'A Google Drive API está desativada no projeto — ative no console do Google.';
        } else if (rp.status === 404) {
          acesso[nome] = 'pasta não encontrada — compartilhe com a service account';
          algumProblema = `${nome}: a service account não enxerga a pasta. Compartilhe com ${sa.client_email}.`;
        } else {
          acesso[nome] = `HTTP ${rp.status}`;
          algumProblema = `${nome}: Drive respondeu ${rp.status}.`;
        }
      }

      resultado.drive = {
        ok: !algumProblema,
        service_account: sa.client_email,
        pastas: acesso,
        msg: algumProblema || 'Credencial válida e pastas acessíveis',
      };
      if (algumProblema) {
        resultado.ok = false;
        resultado.avisos = [...(resultado.avisos || []), algumProblema];
      }
    } catch (err) {
      resultado.drive = { ok: false, msg: `Credencial inválida: ${err.message}` };
      resultado.ok    = false;
    }
  }

  // ── SMTP ─────────────────────────────────────────────────────────────────
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const adapter = require('./cron/_emailAdapter');
      await adapter.verificar();
      resultado.smtp = { ok: true, user: process.env.SMTP_USER, msg: 'Conexão SMTP OK' };
    } catch (err) {
      resultado.smtp = { ok: false, msg: `SMTP falhou: ${err.message}` };
      // SMTP falho não bloqueia ok geral (Etapa 5 ainda não obrigatória)
    }
  }

  return res.status(resultado.ok ? 200 : 503).json(resultado);
};

// Metadados de build injetados pelo Vercel — zerados em dev local
function buildInfo() {
  return {
    commit:      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || 'dev',
    branch:      process.env.VERCEL_GIT_COMMIT_REF            || 'local',
    deploy_id:   process.env.VERCEL_DEPLOYMENT_ID?.slice(0, 12) || null,
    env:         process.env.VERCEL_ENV                        || 'local',
  };
}
