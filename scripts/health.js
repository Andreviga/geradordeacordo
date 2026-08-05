#!/usr/bin/env node
'use strict';
// scripts/health.js — diagnóstico completo antes do uso em produção
// Uso: npm run health
// Testa: banco, Drive, ZapSign e SMTP.

require('./db-utils').loadEnv();
const { getPool }                            = require('../api/_db');
const { criarColeta, loadEnv, runEstruturais } = require('./db-utils');

const OK   = (s)       => process.stdout.write(`  \x1b[32m✓\x1b[0m ${s}\n`);
const FAIL = (s, fix)  => { erros++; process.stderr.write(`  \x1b[31m✗\x1b[0m ${s}\n`); if (fix) process.stderr.write(`      → ${fix}\n`); };
const SKIP = (s)       => process.stdout.write(`  \x1b[33m⊘\x1b[0m ${s}\n`);
const HDR  = (s)       => console.log(`\n${s}\n${'─'.repeat(s.length)}`);

let erros = 0;

// ── Banco de dados ────────────────────────────────────────────────────────────
async function checkDB() {
  HDR('Banco de dados');
  const pool = getPool();
  if (!pool) {
    FAIL('DATABASE_URL ausente',
      'Defina DATABASE_URL no Vercel (Settings → Environment Variables) ou no .env.local');
    return false;
  }

  let client;
  try {
    client = await pool.connect();
    OK('Conexão estabelecida');
  } catch (err) {
    FAIL(`Conexão falhou: ${err.message}`,
      'Verifique DATABASE_URL e se o projeto Neon está ativo');
    return false;
  }

  try {
    const R = criarColeta();
    const tFalt = await runEstruturais(client, R);
    if (R.total === 0) {
      OK('Schema atualizado — todas as 13 tabelas, views e índices presentes');
    } else {
      FAIL(`Schema desatualizado (${R.total} problema(s))`,
        'Execute: npm run db:migrate');
    }

    const { rows: usr } = await client.query(
      'SELECT COUNT(*) AS n FROM usuarios WHERE ativo = true'
    );
    const nUsr = parseInt(usr[0].n, 10);
    if (nUsr > 0) OK(`${nUsr} usuário(s) ativo(s) cadastrado(s)`);
    else           FAIL('Nenhum usuário cadastrado', 'Execute: npm run db:criar-admin');

    const { rows: seq } = await client.query(
      'SELECT ano, ultimo FROM acordo_numero_seq ORDER BY ano DESC LIMIT 3'
    );
    if (seq.length > 0) {
      OK(`Sequência de números: ${seq.map(r => `${r.ano}/${r.ultimo}`).join(', ')}`);
    } else {
      OK('Sequência de números: vazia (primeiro acordo gerará 2026/001)');
    }

    return R.total === 0 && nUsr > 0;
  } finally {
    client.release();
  }
}

// ── Google Drive ──────────────────────────────────────────────────────────────
async function checkDrive() {
  HDR('Google Drive');
  const saRaw    = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const folderId = process.env.DRIVE_PDF_FOLDER_ID;

  if (!saRaw) {
    SKIP('GOOGLE_SERVICE_ACCOUNT_JSON não configurado — PDFs assinados não serão salvos no Drive');
    return null;
  }

  let sa;
  try {
    const text = saRaw.startsWith('{') ? saRaw : Buffer.from(saRaw, 'base64').toString('utf8');
    sa = JSON.parse(text);
    if (!sa.private_key || !sa.client_email) throw new Error('campos obrigatórios ausentes');
    OK(`Service Account: ${sa.client_email}`);
  } catch (err) {
    FAIL(`GOOGLE_SERVICE_ACCOUNT_JSON inválido: ${err.message}`,
      'Copie o JSON do arquivo de chave SA do GCP ou use a versão em base64');
    return false;
  }

  // Obter token de acesso via JWT RS256
  let accessToken;
  try {
    const crypto = require('crypto');
    const now    = Math.floor(Date.now() / 1000);
    const hdr    = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const pay    = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600,
    })).toString('base64url');
    const sig  = crypto.createSign('RSA-SHA256').update(`${hdr}.${pay}`).sign(sa.private_key, 'base64url');
    const jwt  = `${hdr}.${pay}.${sig}`;

    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error_description || d.error || `HTTP ${r.status}`);
    accessToken = d.access_token;
    OK('Token de acesso obtido com sucesso');
  } catch (err) {
    FAIL(`Falha na autenticação SA: ${err.message}`,
      'Revogue e regenere a chave SA no GCP; verifique se a API do Drive está ativa no projeto');
    return false;
  }

  // Verificar acesso à pasta
  if (!folderId) {
    SKIP('DRIVE_PDF_FOLDER_ID não configurado — pasta de destino não verificada');
  } else {
    try {
      const r = await fetch(
        `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const d = await r.json();
      if (r.ok) OK(`Pasta acessível: ${folderId}`);
      else throw new Error(d.error?.message || `HTTP ${r.status}`);
    } catch (err) {
      FAIL(`Pasta inacessível: ${err.message}`,
        'Compartilhe a pasta com o e-mail da SA; use uma pasta no Drive Compartilhado');
      return false;
    }

    // Upload de teste + deleção
    try {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({
        name: '_health_check_delete_me.txt',
        parents: [folderId],
      })], { type: 'application/json' }));
      form.append('file', new Blob(['ok'], { type: 'text/plain' }));

      const up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: form,
      });
      const upD = await up.json();
      if (!up.ok) throw new Error(upD.error?.message || `HTTP ${up.status}`);

      await fetch(`https://www.googleapis.com/drive/v3/files/${upD.id}?supportsAllDrives=true`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` },
      });
      OK('Upload de teste e deleção: OK');
    } catch (err) {
      FAIL(`Upload de teste falhou: ${err.message}`,
        'Verifique as permissões de escrita na pasta');
      return false;
    }
  }

  return true;
}

// ── ZapSign ───────────────────────────────────────────────────────────────────
async function checkZapSign() {
  HDR('ZapSign (assinatura digital)');
  const token = process.env.ZAPSIGN_API_TOKEN;
  const prov  = (process.env.ASSINATURA_PROVIDER || 'manual').toLowerCase();

  if (prov === 'manual' && !token) {
    SKIP('Provedor configurado como "manual" — ZapSign não ativo');
    return null;
  }
  if (!token) {
    SKIP('ZAPSIGN_API_TOKEN não configurado');
    return null;
  }

  try {
    const r = await fetch('https://api.zapsign.com.br/api/v1/docs/?page=1&page_size=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const d = await r.json();
      OK(`ZapSign acessível — ${d.count ?? '?'} documento(s) na conta`);
      return true;
    } else if (r.status === 401) {
      FAIL('ZAPSIGN_API_TOKEN inválido (401)', 'Verifique o token no painel ZapSign');
      return false;
    } else {
      FAIL(`ZapSign respondeu ${r.status}`, 'Verifique a conectividade e o token');
      return false;
    }
  } catch (err) {
    FAIL(`ZapSign inacessível: ${err.message}`);
    return false;
  }
}

// ── SMTP (Gmail) ──────────────────────────────────────────────────────────────
async function checkSMTP() {
  HDR('E-mail SMTP (lembretes — Etapa 5)');
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    SKIP('SMTP_USER ou SMTP_PASS ausente — lembretes por e-mail não configurados (Etapa 5)');
    return null;
  }

  try {
    const adapter = require('../api/cron/_emailAdapter');
    await adapter.verificar();
    OK(`SMTP OK — conectado como ${process.env.SMTP_USER}`);
    return true;
  } catch (err) {
    FAIL(`SMTP falhou: ${err.message}`,
      'Verifique SMTP_USER, SMTP_PASS (deve ser senha de app, não a senha da conta) e se o acesso SMTP está ativo na conta Gmail');
    return false;
  }
}

// ── Variáveis críticas ────────────────────────────────────────────────────────
function checkEnvVars() {
  HDR('Variáveis de ambiente');
  const check = (name, required, note) => {
    const val = process.env[name];
    if (val)      OK(`${name} configurada`);
    else if (required) FAIL(`${name} ausente — obrigatória`, note);
    else          SKIP(`${name} não configurada${note ? ' — ' + note : ''}`);
  };

  check('JWT_SECRET',     true,  'Gere com: openssl rand -hex 32');
  check('DATABASE_URL',   true,  'Connection string do Neon');
  check('ALLOWED_ORIGIN', true,  'URL de produção sem barra final (ex: https://geradordeacordo.vercel.app)');
  check('ASSINATURA_PROVIDER', false, 'Padrão: manual');
  check('ZAPSIGN_API_TOKEN',   false, 'Necessário se ASSINATURA_PROVIDER=zapsign');
  check('GOOGLE_SERVICE_ACCOUNT_JSON', false, 'Necessário para salvar PDFs no Drive');
  check('DRIVE_PDF_FOLDER_ID', false, 'Pasta de destino dos PDFs assinados');

  // Variáveis que devem ser removidas
  const legadas = ['APP_PASSWORD_HASH', 'ADOBE_SIGN_INTEGRATION_KEY', 'ADOBE_SIGN_REGION'];
  for (const name of legadas) {
    if (process.env[name]) {
      FAIL(`${name} ainda presente — remover do Vercel`,
        'Esta variável não tem mais efeito e pode causar confusão; remova-a');
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Identificar o banco-alvo antes de qualquer check — evita confusão produção/branch
  const rawUrl = process.env.DATABASE_URL || '';
  let bancoLabel = '(DATABASE_URL não configurado)';
  try {
    const u = new URL(rawUrl);
    bancoLabel = `${u.hostname}${u.pathname}`;
  } catch {}

  console.log('\nDiagnóstico de produção — Gerador de Acordo');
  console.log(`Banco-alvo: \x1b[1m${bancoLabel}\x1b[0m`);
  console.log('═'.repeat(44));

  checkEnvVars();
  const dbOk    = await checkDB();
  const drOk    = await checkDrive();
  const zapOk   = await checkZapSign();
  const smtpOk  = await checkSMTP();

  console.log('\n' + '═'.repeat(44));
  if (erros === 0) {
    console.log('\x1b[32mTodos os checks passaram — sistema pronto para uso.\x1b[0m\n');
    process.exit(0);
  } else {
    console.error(`\x1b[31m${erros} problema(s) encontrado(s). Corrija antes de usar em produção.\x1b[0m\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\nErro inesperado:', err.message);
  process.exit(1);
});
