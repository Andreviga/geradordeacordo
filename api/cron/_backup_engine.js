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

// Traduz as falhas de Drive que já custaram tempo aqui. O corpo cru do erro do
// Google é longo e não diz o que fazer; estas três respondem a pergunta certa.
function explicarErroDrive(status, corpo, pastaId, saEmail) {
  if (/has not been used in project|is disabled/i.test(corpo))
    return 'a Google Drive API está desativada no projeto GCP — ative no console do Google.';
  if (status === 404)
    return `a service account não enxerga a pasta ${pastaId}. O Drive responde 404 (e não 403) `
         + `quando não há acesso nenhum. Compartilhe a pasta com ${saEmail || 'a service account'} como Editor.`;
  if (/storage quota|quotaExceeded/i.test(corpo))
    return 'a pasta está em "Meu Drive": o arquivo criado fica sob a cota da service account, que é zero. '
         + 'Use uma pasta em Drive Compartilhado.';
  return null;
}

async function uploadGzip(token, nome, bufGzip, pastaId, saEmail) {
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
  if (!r.ok) {
    const corpo = await r.text();
    const causa = explicarErroDrive(r.status, corpo, pastaId, saEmail);
    throw new Error(causa
      ? `Upload Drive falhou (HTTP ${r.status}): ${causa}`
      : `Upload Drive falhou: HTTP ${r.status} — ${corpo.slice(0, 200)}`);
  }
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

// ─── Dump ─────────────────────────────────────────────────────────────────────
/** Lê o banco inteiro e devolve o .json.gz. Sem destino — quem envia é quem chama. */
async function montarDump(pool) {
  const dump = { _meta: { gerado_em: new Date().toISOString(), tabelas: TABELAS }, dados: {} };
  let totalLinhas = 0;
  for (const tabela of TABELAS) {
    const { rows } = await pool.query(`SELECT * FROM ${tabela} ORDER BY 1`).catch(() => ({ rows: [] }));
    dump.dados[tabela] = rows;
    totalLinhas += rows.length;
  }
  const json    = JSON.stringify(dump);
  const bufGzip = await new Promise((ok, err) => zlib.gzip(Buffer.from(json), (e, b) => e ? err(e) : ok(b)));
  return { dump, bufGzip, totalLinhas };
}

// ─── Destino: e-mail ──────────────────────────────────────────────────────────
// Existe porque service account não tem cota de armazenamento: sem um Drive
// Compartilhado (que exige Workspace Business Standard), ela não consegue gravar
// arquivo nenhum. O e-mail reaproveita o SMTP que já funciona para os lembretes.
async function enviarPorEmail(bufGzip, nomeArquivo, totalLinhas) {
  const para  = (process.env.BACKUP_EMAIL || '').trim();
  const senha = process.env.BACKUP_SENHA;

  // Cifrar não é opcional aqui. O anexo é a base inteira: CPF, RG, endereço e
  // telefone de responsáveis, e nome de menores. Mandar em claro, toda semana,
  // trocaria "não ter backup" por "vazar a base se a caixa for comprometida".
  if (!senha)
    throw new Error(
      'BACKUP_SENHA não configurada. O backup por e-mail leva a base inteira em anexo '
      + '(CPF, endereços, dados de menores) e por isso só é enviado cifrado. '
      + 'Defina BACKUP_SENHA no Vercel e guarde-a fora de lá — sem ela o backup não é recuperável.');

  const { cifrar } = require('./_backup_cripto');
  const anexo = cifrar(bufGzip, senha);
  const nome  = `${nomeArquivo}.enc`;

  const adapter = require('./_emailAdapter');
  await adapter.send({
    to: para,
    subject: `Backup do Gerador de Acordo — ${nomeArquivo}`,
    text: [
      'Backup automático da base do Gerador de Acordo.',
      '',
      `Arquivo : ${nome}`,
      `Linhas  : ${totalLinhas}`,
      `Tamanho : ${(anexo.length / 1024).toFixed(1)} KB`,
      '',
      'O anexo está CIFRADO (AES-256-GCM) com a BACKUP_SENHA configurada no servidor.',
      'Para restaurar:  npm run db:restore -- <arquivo> --senha=SUA_SENHA',
      '',
      'Guarde este e-mail. Sem a senha, o arquivo não é recuperável.',
    ].join('\n'),
    attachments: [{ filename: nome, content: anexo }],
  });

  console.log(`[backup] e-mail enviado para ${para}: ${nome} (${anexo.length} bytes)`);
  return { tipo: 'email', nome, tamanho: anexo.length, para };
}

// ─── Executor ─────────────────────────────────────────────────────────────────
async function executarBackup(pool) {
  const creds     = parseCredenciais();
  const pastaId   = process.env.DRIVE_BACKUP_FOLDER_ID;
  const usarDrive = !!(creds && pastaId);
  const usarEmail = !!(process.env.BACKUP_EMAIL || '').trim();

  if (!usarDrive && !usarEmail)
    throw new Error(
      'Nenhum destino de backup configurado. Defina DRIVE_BACKUP_FOLDER_ID (com '
      + 'GOOGLE_SERVICE_ACCOUNT_JSON) para gravar no Drive, ou BACKUP_EMAIL para receber '
      + 'o arquivo cifrado por e-mail. Os dois juntos também funcionam.');

  const { bufGzip, totalLinhas } = await montarDump(pool);
  const agora   = new Date();
  const uploads = [];
  const falhas  = [];

  // Cada destino é independente: um que falhe não pode anular o que já deu
  // certo. Aconteceu na primeira execução real — o e-mail saiu, o Drive falhou
  // por cota, e mesmo assim o cron reportou erro, como se nada tivesse sido
  // salvo. Numa retentativa o e-mail seria enviado de novo, sem necessidade.
  async function tentar(nome, fn) {
    try {
      await fn();
    } catch (err) {
      falhas.push({ destino: nome, erro: err.message });
      console.error(`[backup] destino "${nome}" falhou: ${err.message}`);
    }
  }

  // O e-mail vai primeiro: não depende da rede do Google e é o destino que
  // sobra quando o Drive não está disponível.
  if (usarEmail) {
    await tentar('email', async () => {
      uploads.push(await enviarPorEmail(bufGzip, `backup-weekly-${isoWeek(agora)}.json.gz`, totalLinhas));
    });
  }

  if (usarDrive) {
    await tentar('drive', async () => {
      const token = await obterToken(creds);

      // Upload semanal + retenção (4 semanas)
      const nomeW = `backup-weekly-${isoWeek(agora)}.json.gz`;
      const fw    = await uploadGzip(token, nomeW, bufGzip, pastaId, creds.client_email);
      uploads.push({ tipo: 'weekly', nome: fw.name, tamanho: fw.size });
      console.log(`[backup] semanal: ${fw.name} (${fw.size} bytes)`);

      const semanais = await listarArquivosPorPrefixo(token, 'backup-weekly-', pastaId);
      for (const f of semanais.slice(0, Math.max(0, semanais.length - 4))) {
        await deletarArquivo(token, f.id);
        console.log(`[backup] removido semanal antigo: ${f.name}`);
      }

      // Upload mensal (primeira segunda do mês) + retenção (12 meses)
      if (isPrimeiraMondayDoMes(agora)) {
        const mes   = agora.toISOString().slice(0, 7);
        const nomeM = `backup-monthly-${mes}.json.gz`;
        const fm    = await uploadGzip(token, nomeM, bufGzip, pastaId, creds.client_email);
        uploads.push({ tipo: 'monthly', nome: fm.name, tamanho: fm.size });
        console.log(`[backup] mensal: ${fm.name} (${fm.size} bytes)`);

        const mensais = await listarArquivosPorPrefixo(token, 'backup-monthly-', pastaId);
        for (const f of mensais.slice(0, Math.max(0, mensais.length - 12))) {
          await deletarArquivo(token, f.id);
          console.log(`[backup] removido mensal antigo: ${f.name}`);
        }
      }
    });
  }

  // Só é erro quando NENHUM destino funcionou: aí não existe cópia do backup.
  if (!uploads.length) {
    const e = new Error('Backup não foi salvo em nenhum destino. '
      + falhas.map(f => `${f.destino}: ${f.erro}`).join(' | '));
    e.falhas = falhas;
    throw e;
  }

  if (falhas.length)
    console.warn(`[backup] concluído com ${falhas.length} destino(s) em falha, `
      + `mas o backup está salvo em: ${uploads.map(u => u.tipo).join(', ')}`);

  return { ok: true, totalLinhas, uploads, ...(falhas.length ? { falhas } : {}) };
}

module.exports = { executarBackup, montarDump, enviarPorEmail, TABELAS, explicarErroDrive };
