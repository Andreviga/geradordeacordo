// api/assinatura/_drive.js — Google Drive via Service Account para uso server-side
//
// Env vars:
//   GOOGLE_SERVICE_ACCOUNT_JSON  JSON da conta de serviço GCP
//                                Aceita JSON direto OU string base64 do JSON (recomendado):
//                                  base64 -w0 service-account.json | tr -d '\n'
//                                Para evitar problema de \n na chave privada em alguns UIs.
//   DRIVE_PDF_FOLDER_ID          ID de pasta em Drive Compartilhado (Workspace) para salvar PDFs.
//                                Não use "Meu Drive" — arquivos da SA ali ficam sob cota da SA.
//
// Sem GOOGLE_SERVICE_ACCOUNT_JSON: verificarEvento() retorna null.
//   Para doc_signed, o webhook responde 500 — não há fallback silencioso.
//
// Corrida (TOCTOU): verificarEvento + marcarEvento não são atômicos.
//   Dois eventos simultâneos podem ambos passar pela verificação.
//   Inofensivo no volume atual (dois PDFs com mesmo nome no Drive).
//   Fase E precisa de UNIQUE constraint no banco para garantia real.

'use strict';

const crypto = require('crypto');
const BASE   = 'https://www.googleapis.com';
// Parâmetros obrigatórios para Drive Compartilhado (Shared Drive / Team Drive)
const SD = 'supportsAllDrives=true&includeItemsFromAllDrives=true';
const sd = (path) => path + (path.includes('?') ? '&' : '?') + SD;

let _pastaVerificada = false; // evita verificação repetida por instância

function parseCredenciais() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  // Suporta JSON direto ou base64 do JSON (recomendado para evitar quebra de linha na chave privada)
  const tentativas = [raw];
  if (!raw.trimStart().startsWith('{')) tentativas.unshift(Buffer.from(raw.trim(), 'base64').toString('utf8'));
  for (const t of tentativas) {
    try {
      const creds = JSON.parse(t);
      if (!creds.client_email || !creds.private_key) throw new Error('Campos obrigatórios ausentes: client_email, private_key');
      return creds;
    } catch (e) {
      // continua para próxima tentativa
    }
  }
  console.error(
    '[drive] GOOGLE_SERVICE_ACCOUNT_JSON inválido. ' +
    'Formate como JSON válido ou como base64 do JSON (base64 -w0 sa.json). ' +
    'Certifique-se de que client_email e private_key estão presentes.'
  );
  return null;
}

async function obterToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const pld = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })).toString('base64url');
  const sig = crypto.createSign('RSA-SHA256')
    .update(`${hdr}.${pld}`)
    .sign(creds.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${hdr}.${pld}.${sig}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Auth SA falhou: ' + JSON.stringify(d).slice(0, 200));
  return d.access_token;
}

async function driveGet(token, path) {
  const r = await fetch(`https://www.googleapis.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return r;
}

async function drivePost(token, path, contentType, body) {
  const r = await fetch(`https://www.googleapis.com${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body,
  });
  return r;
}

async function drivePatch(token, path, contentType, body) {
  await fetch(`https://www.googleapis.com${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body,
  });
}

async function buscarArquivoPorNome(token, nome, pastaId) {
  const conds = [`name='${nome}'`, 'trashed=false'];
  if (pastaId) conds.push(`'${pastaId}' in parents`);
  const q = encodeURIComponent(conds.join(' and '));
  const r = await driveGet(token, sd(`/drive/v3/files?q=${q}&fields=files(id)&pageSize=2`));
  const d = await r.json();
  return (d.files && d.files[0]) ? d.files[0].id : null;
}

async function criarArquivoVazio(token, nome, pastaId) {
  const meta = { name: nome, mimeType: 'application/json' };
  if (pastaId) meta.parents = [pastaId];
  const r = await drivePost(token, sd('/drive/v3/files'), 'application/json', JSON.stringify(meta));
  const f = await r.json();
  if (!f.id) throw new Error('Falha ao criar arquivo de idempotência: ' + JSON.stringify(f).slice(0, 200));
  return f.id;
}

async function lerJson(token, fileId) {
  const r = await driveGet(token, sd(`/drive/v3/files/${fileId}?alt=media`));
  if (!r.ok) return {};
  try { return await r.json(); } catch { return {}; }
}

async function escreverJson(token, fileId, dados) {
  await drivePatch(token, sd(`/upload/drive/v3/files/${fileId}?uploadType=media`), 'application/json', JSON.stringify(dados));
}

// Verifica se a pasta é Drive Compartilhado; loga erro se for "Meu Drive"
async function verificarTipoPasta(token, pastaId) {
  if (_pastaVerificada || !pastaId) { _pastaVerificada = true; return; }
  _pastaVerificada = true;
  try {
    const r = await driveGet(token, sd(`/drive/v3/files/${pastaId}?fields=id,name,driveId`));
    if (!r.ok) { console.warn('[drive] Não foi possível verificar DRIVE_PDF_FOLDER_ID'); return; }
    const d = await r.json();
    if (!d.driveId) {
      console.error(
        '[drive] ⚠️  DRIVE_PDF_FOLDER_ID aponta para "Meu Drive", não para Drive Compartilhado. ' +
        'Arquivos da SA ficam sob cota da SA e podem ser bloqueados por políticas do Workspace. ' +
        'Compartilhe uma pasta de Drive Compartilhado com a SA como Contribuidora.'
      );
    } else {
      console.log(`[drive] Pasta OK: "${d.name}" (Drive Compartilhado: ${d.driveId})`);
    }
  } catch (e) { console.warn('[drive] Falha ao verificar tipo de pasta:', e.message); }
}

async function verificarEvento(chave) {
  const creds = parseCredenciais();
  if (!creds) return null;
  const token   = await obterToken(creds);
  const pastaId = process.env.DRIVE_PDF_FOLDER_ID || null;
  await verificarTipoPasta(token, pastaId);
  const fileId  = await buscarArquivoPorNome(token, '_eventos_webhook.json', pastaId);
  if (!fileId) return { status: null };
  const dados   = await lerJson(token, fileId);
  const entrada = dados[chave];
  if (!entrada)                return { status: null };
  if (typeof entrada === 'number') return { status: 'ok', failCount: 0 }; // retrocompat
  return entrada; // { status, failCount, ultimoErro? }
}

async function marcarEvento(chave) {
  const creds = parseCredenciais();
  if (!creds) throw new Error('Drive não configurado: GOOGLE_SERVICE_ACCOUNT_JSON ausente');
  const token   = await obterToken(creds);
  const pastaId = process.env.DRIVE_PDF_FOLDER_ID || null;
  let fileId = await buscarArquivoPorNome(token, '_eventos_webhook.json', pastaId);
  if (!fileId) fileId = await criarArquivoVazio(token, '_eventos_webhook.json', pastaId);
  const dados = await lerJson(token, fileId);
  const expirar = Date.now() - 60 * 24 * 60 * 60 * 1000;
  for (const k of Object.keys(dados)) {
    const v = dados[k]; const ts = typeof v === 'number' ? v : v?.ts;
    if (ts && ts < expirar) delete dados[k];
  }
  dados[chave] = { ts: Date.now(), status: 'ok' };
  await escreverJson(token, fileId, dados);
}

async function marcarFalha(chave, erro, zapsignToken) {
  // Logar SEMPRE — mesmo que o Drive esteja falhando, esse log aparece no Vercel.
  // O zapsignToken permite recuperar o PDF manualmente na plataforma ZapSign.
  console.error(
    `[drive] FALHA ${chave} | erro: ${String(erro).slice(0, 200)}` +
    (zapsignToken ? ` | ZapSign token para recuperação manual: ${zapsignToken}` : '')
  );

  const creds = parseCredenciais();
  if (!creds) return; // sem SA: log acima é o único registro possível
  try {
    const token   = await obterToken(creds);
    const pastaId = process.env.DRIVE_PDF_FOLDER_ID || null;
    let fileId = await buscarArquivoPorNome(token, '_eventos_webhook.json', pastaId);
    if (!fileId) fileId = await criarArquivoVazio(token, '_eventos_webhook.json', pastaId);
    const dados = await lerJson(token, fileId);
    const ant       = dados[chave];
    const failCount = (typeof ant === 'object' && ant?.failCount) ? ant.failCount + 1 : 1;
    dados[chave] = {
      ts: Date.now(), status: 'failed', failCount,
      ultimoErro: String(erro).slice(0, 300),
      zapsignToken: zapsignToken || null, // preservar para recuperação manual
    };
    await escreverJson(token, fileId, dados);
    if (failCount >= 3) {
      // Drive disponível → também gravar em _pendencias.json para visibilidade na UI
      await registrarPendencia(token, pastaId, chave, erro, zapsignToken, failCount);
    }
  } catch (driveErr) {
    // Dependência circular: Drive está falhando E é onde gravamos a falha.
    // O log acima (com zapsignToken) é o único caminho de recuperação nesse caso.
    console.error('[drive] Drive indisponível ao registrar falha. Token ZapSign para recuperação:', zapsignToken || '—');
  }
}

// Grava pendência com token ZapSign em arquivo separado visível na UI
async function registrarPendencia(token, pastaId, chave, erro, zapsignToken, failCount) {
  try {
    let fileId = await buscarArquivoPorNome(token, '_pendencias.json', pastaId);
    if (!fileId) fileId = await criarArquivoVazio(token, '_pendencias.json', pastaId);
    const dados = await lerJson(token, fileId);
    dados[chave] = {
      ts: Date.now(), zapsignToken: zapsignToken || null,
      failCount, ultimoErro: String(erro).slice(0, 200), status: 'permanente',
    };
    await escreverJson(token, fileId, dados);
    console.error(`[drive] 🔴 FALHA PERMANENTE registrada em _pendencias.json: ${chave} | ZapSign: ${zapsignToken || '—'}`);
  } catch (e) { console.error('[drive] Falha ao registrar pendência:', e.message); }
}

/**
 * Baixa o PDF do URL temporário e salva no Drive da conta de serviço.
 * Deve ser chamado imediatamente no evento doc_signed — link expira em 60 min.
 * @returns {string|null} ID do arquivo no Drive, ou null se Drive não configurado
 */
async function salvarPdfAssinado(signedUrl, nomeArquivo) {
  const creds = parseCredenciais();
  if (!creds) {
    console.warn('[drive] PDF assinado não persistido: GOOGLE_SERVICE_ACCOUNT_JSON não configurado.');
    return null;
  }

  const token = await obterToken(creds);

  const dl = await fetch(signedUrl);
  if (!dl.ok) throw new Error(`Falha ao baixar PDF assinado: HTTP ${dl.status}`);
  const pdfBuf = Buffer.from(await dl.arrayBuffer());

  const pastaId = process.env.DRIVE_PDF_FOLDER_ID || null;
  const bound   = `DriveUpload${Date.now()}`;
  const meta    = JSON.stringify({ name: nomeArquivo, ...(pastaId ? { parents: [pastaId] } : {}) });

  const body = Buffer.concat([
    Buffer.from(`--${bound}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}`
              + `\r\n--${bound}\r\nContent-Type: application/pdf\r\n\r\n`),
    pdfBuf,
    Buffer.from(`\r\n--${bound}--`),
  ]);

  const r = await drivePost(
    token,
    sd(`/upload/drive/v3/files?uploadType=multipart&fields=id,name`),
    `multipart/related; boundary=${bound}`,
    body,
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => r.status);
    throw new Error(`Falha ao salvar PDF no Drive: HTTP ${r.status} — ${String(txt).slice(0, 200)}`);
  }
  const f = await r.json();
  console.log(`[drive] PDF assinado salvo: ${f.name} (id: ${f.id})`);
  return f.id;
}

// Lê _pendencias.json para exibição na interface (secretaria verifica falhas pendentes)
async function lerPendencias() {
  const creds = parseCredenciais();
  if (!creds) return null;
  try {
    const token   = await obterToken(creds);
    const pastaId = process.env.DRIVE_PDF_FOLDER_ID || null;
    const fileId  = await buscarArquivoPorNome(token, '_pendencias.json', pastaId);
    if (!fileId) return {};
    return await lerJson(token, fileId);
  } catch { return null; }
}

module.exports = { verificarEvento, marcarEvento, marcarFalha, salvarPdfAssinado, lerPendencias };
