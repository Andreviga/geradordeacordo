'use strict';
// api/cron/_backup_engine.js — lógica de dump e upload para o Drive.
//
// Variáveis de ambiente necessárias:
//   GOOGLE_SERVICE_ACCOUNT_JSON  (já usada pelo módulo de assinatura)
//   DRIVE_BACKUP_FOLDER_ID       ID da pasta de backup no Drive Compartilhado
//
// Formato: JSON comprimido com zlib (deflate) → filename .json.gz
// Tabelas: todas as tabelas de dados (sem vistas, sem sequences internas)

const zlib   = require('zlib');
const crypto = require('crypto');

// Tabelas na ordem certa para restore (FK → pai antes de filho)
const TABELAS = [
  'usuarios',
  'devedores',
  'credoras',
  'alunos',
  'acordos',
  'acordo_numero_seq',
  'acordo_devedores',
  'acordo_credoras',
  'acordo_alunos',
  'parcelas',
  'lembretes_enviados',
  'eventos_webhook',
  'auditoria_exclusoes',
];

const BASE = 'https://www.googleapis.com';
const SD   = 'supportsAllDrives=true&includeItemsFromAllDrives=true';
const sd   = p => p + (p.includes('?') ? '&' : '?') + SD;

// ─── Auth Drive ───────────────────────────────────────────────────────────────
function parseCredenciais() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  const tentativas = [raw];
  if (!raw.trimStart().startsWith('{')) tentativas.unshift(Buffer.from(raw.trim(), 'base64').toString('utf8'));
  for (const t of tentativas) {
    try { const c = JSON.parse(t); if (c.client_email && c.private_key) return c; } catch {}
  }
  return null;
}

async function obterToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const pld = Buffer.from(JSON.stringify({
    iss: creds.client_email, scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })).toString('base64url');
  const sig = crypto.createSign('RSA-SHA256').update(`${hdr}.${pld}`).sign(creds.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${hdr}.${pld}.${sig}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Auth SA falhou: ' + JSON.stringify(d).slice(0, 200));
  return d.access_token;
}

// ─── Utilitários Drive ────────────────────────────────────────────────────────
async function listarArquivosPorPrefixo(token, prefixo, pastaId) {
  const q  = encodeURIComponent(`name contains '${prefixo}' and trashed=false${pastaId ? ` and '${pastaId}' in parents` : ''}`);
  const r  = await fetch(`${BASE}${sd(`/drive/v3/files?q=${q}&fields=files(id,name,createdTime)&orderBy=createdTime`)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d  = await r.json();
  return (d.files || []).sort((a, b) => a.createdTime.localeCompare(b.createdTime));
}

async function deletarArquivo(token, fileId) {
  await fetch(`${BASE}${sd(`/drive/v3/files/${fileId}`)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
}

async function uploadGzip(token, nome, bufGzip, pastaId) {
  const bound = `DriveBackup${Date.now()}`;
  const meta  = JSON.stringify({ name: nome, mimeType: 'application/gzip',
    ...(pastaId ? { parents: [pastaId] } : {}) });
  const body  = Buffer.concat([
    Buffer.from(`--${bound}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}`
              + `\r\n--${bound}\r\nContent-Type: application/gzip\r\n\r\n`),
    bufGzip,
    Buffer.from(`\r\n--${bound}--`),
  ]);
  const r = await fetch(`${BASE}${sd('/upload/drive/v3/files?uploadType=multipart&fields=id,name,size')}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${bound}` },
    body,
  });
  if (!r.ok) throw new Error(`Upload Drive falhou: HTTP ${r.status} — ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

// ─── Número ISO da semana ─────────────────────────────────────────────────────
function isoWeek(d) {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - new Date(Date.UTC(y, 0, 1))) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

function isPrimeiraMondayDoMes(data) {
  // Retorna true se o dia for segunda-feira e o dia do mês for ≤ 7
  return data.getUTCDay() === 1 && data.getUTCDate() <= 7;
}

// ─── Executor ─────────────────────────────────────────────────────────────────
async function executarBackup(pool) {
  const creds = parseCredenciais();
  if (!creds) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não configurado');

  const pastaId = process.env.DRIVE_BACKUP_FOLDER_ID;
  if (!pastaId) throw new Error('DRIVE_BACKUP_FOLDER_ID não configurado');

  // 1. Dump de todas as tabelas
  const dump = { _meta: { gerado_em: new Date().toISOString(), tabelas: TABELAS }, dados: {} };
  let totalLinhas = 0;
  for (const tabela of TABELAS) {
    const { rows } = await pool.query(`SELECT * FROM ${tabela} ORDER BY 1`).catch(() => ({ rows: [] }));
    dump.dados[tabela] = rows;
    totalLinhas += rows.length;
  }

  // 2. Serializar e comprimir
  const json    = JSON.stringify(dump);
  const bufGzip = await new Promise((ok, err) => zlib.gzip(Buffer.from(json), (e, b) => e ? err(e) : ok(b)));

  const agora   = new Date();
  const token   = await obterToken(creds);
  const uploads = [];

  // 3. Upload semanal + retenção (4 semanas)
  const nomeW = `backup-weekly-${isoWeek(agora)}.json.gz`;
  const fw    = await uploadGzip(token, nomeW, bufGzip, pastaId);
  uploads.push({ tipo: 'weekly', nome: fw.name, tamanho: fw.size });
  console.log(`[backup] semanal: ${fw.name} (${fw.size} bytes)`);

  const semanais = await listarArquivosPorPrefixo(token, 'backup-weekly-', pastaId);
  for (const f of semanais.slice(0, Math.max(0, semanais.length - 4))) {
    await deletarArquivo(token, f.id);
    console.log(`[backup] removido semanal antigo: ${f.name}`);
  }

  // 4. Upload mensal (primeira segunda do mês) + retenção (12 meses)
  if (isPrimeiraMondayDoMes(agora)) {
    const mes   = agora.toISOString().slice(0, 7);
    const nomeM = `backup-monthly-${mes}.json.gz`;
    const fm    = await uploadGzip(token, nomeM, bufGzip, pastaId);
    uploads.push({ tipo: 'monthly', nome: fm.name, tamanho: fm.size });
    console.log(`[backup] mensal: ${fm.name} (${fm.size} bytes)`);

    const mensais = await listarArquivosPorPrefixo(token, 'backup-monthly-', pastaId);
    for (const f of mensais.slice(0, Math.max(0, mensais.length - 12))) {
      await deletarArquivo(token, f.id);
      console.log(`[backup] removido mensal antigo: ${f.name}`);
    }
  }

  return { ok: true, totalLinhas, uploads };
}

module.exports = { executarBackup };
