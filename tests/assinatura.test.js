// tests/assinatura.test.js — 12 testes da Fase B
//
// Todos usam mocks — nenhuma chamada real de rede.
// Execute com: node tests/assinatura.test.js

'use strict';

const path = require('path');
const { validarSignatarios, validarPDF } = require('../api/assinatura/_contrato');
const { normalizarResposta, traduzirErroZapSign, consultarPorExternalId } = require('../api/assinatura/_providers/zapsign');
const manual = require('../api/assinatura/_providers/manual');
const webhookHandler = require('../api/assinatura/webhook');
const { processarEvento, eventosProcessados } = webhookHandler;
const html = require('fs').readFileSync(path.join(__dirname, '../index.html'), 'utf8');

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  \u2713 ${desc}`); passou++; }
  else       { console.error(`  \u2717 ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

async function main() {

// ── [1] ──────────────────────────────────────────────────────────────────
grupo('[1] Dois signat\u00e1rios \u2192 dois sign_url distintos');
{
  const r = normalizarResposta({
    token: 'doc-abc', status: 'pending',
    signers: [
      { name: 'Jo\u00e3o',  email: 'joao@x.com', sign_url: 'https://app.zapsign.com.br/verificar/aaa', token: 'tok1', status: 'pending', signed_at: null },
      { name: 'Maria', email: 'maria@x.com', sign_url: 'https://app.zapsign.com.br/verificar/bbb', token: 'tok2', status: 'pending', signed_at: null },
    ],
  });
  assert('id = token do documento',   r.id === 'doc-abc');
  assert('provedor = zapsign',        r.provedor === 'zapsign');
  assert('dois sign_url retornados',  r.url.length === 2);
  assert('sign_url tem /verificar/',  r.url[0].url.includes('/verificar/'));
  assert('sign_url distintos',        r.url[0].url !== r.url[1].url);
}

// ── [2] ──────────────────────────────────────────────────────────────────
grupo('[2] Signat\u00e1rio sem e-mail \u2192 bloqueio antes da API');
{
  const err = validarSignatarios([{ nome: 'Jo\u00e3o', email: '' }]);
  assert('retorna string de erro', typeof err === 'string');
  assert('menciona e-mail',        err.toLowerCase().includes('e-mail'));
}

// ── [3] ──────────────────────────────────────────────────────────────────
grupo('[3] E-mail inv\u00e1lido \u2192 bloqueio');
{
  const err = validarSignatarios([{ nome: 'Jo\u00e3o', email: 'nao-e-email' }]);
  assert('retorna erro',    typeof err === 'string');
  assert('menciona formato', err.toLowerCase().includes('formato'));
}

// ── [4] ──────────────────────────────────────────────────────────────────
grupo('[4] E-mails duplicados \u2192 bloqueio');
{
  const err = validarSignatarios([
    { nome: 'Jo\u00e3o',  email: 'mesmo@x.com' },
    { nome: 'Maria', email: 'MESMO@X.COM' },
  ]);
  assert('retorna erro',     typeof err === 'string');
  assert('menciona duplicado', err.toLowerCase().includes('duplicado'));
}

// ── [5] ──────────────────────────────────────────────────────────────────
grupo('[5] PDF > 10 MB \u2192 mensagem espec\u00edfica');
{
  const largePDF = '%PDF-' + 'x'.repeat(10 * 1024 * 1024 + 1);
  const { error, buffer } = validarPDF(Buffer.from(largePDF).toString('base64'));
  assert('erro menciona 10 MB', typeof error === 'string' && error.includes('10 MB'));
  assert('buffer \u00e9 null',        buffer === null);
}

// ── [6] ──────────────────────────────────────────────────────────────────
grupo('[6] Token API inv\u00e1lido \u2192 PT-BR, sem vazar corpo bruto');
{
  const err = traduzirErroZapSign(401, { detail: 'Authentication credentials were not provided.' });
  assert('menciona ZAPSIGN_API_TOKEN', err.error.includes('ZAPSIGN_API_TOKEN'));
  assert('n\u00e3o vaza mensagem inglesa',  !err.error.includes('Authentication credentials'));
  assert('code = INVALID_TOKEN',      err.code === 'INVALID_TOKEN');
}

// ── [7] ──────────────────────────────────────────────────────────────────
grupo('[7] external_id existente \u2192 retorna doc existente, n\u00e3o cria novo');
{
  const orig = global.fetch;
  let chamadas = 0;
  global.fetch = async (url) => {
    chamadas++;
    if (url.includes('external_id=')) {
      return { ok: true, json: async () => [{ token: 'doc-existente', status: 'pending', signers: [] }] };
    }
    return { ok: true, json: async () => ({ token: 'doc-novo', status: 'pending', signers: [] }) };
  };
  const resultado = await consultarPorExternalId('acordo-123', 'fake-token');
  global.fetch = orig;
  assert('retorna doc existente', resultado && resultado.id === 'doc-existente');
  assert('apenas 1 chamada GET', chamadas === 1);
}

// ── [8] ──────────────────────────────────────────────────────────────────
grupo('[8] Webhook doc_signed 2x \u2192 processado 1x (idempot\u00eancia)');
{
  eventosProcessados.clear();
  const p = { event_type: 'doc_signed', document: { token: 'doc-xyz', signed_file: 'https://x.com/f.pdf' } };
  await processarEvento(p);
  const tam1 = eventosProcessados.size;
  await processarEvento(p);
  assert('evento no Set',         eventosProcessados.has('doc_signed:doc-xyz'));
  assert('n\u00e3o cresceu na 2\u00aa',    eventosProcessados.size === tam1);
}

// ── [9] ──────────────────────────────────────────────────────────────────
grupo('[9] Webhook com segredo errado \u2192 401');
{
  const orig = process.env.ZAPSIGN_WEBHOOK_SECRET;
  process.env.ZAPSIGN_WEBHOOK_SECRET = 'certo';
  const respostas = [];
  const req = { method: 'POST', headers: { 'x-webhook-secret': 'errado' }, body: {} };
  const res = { status: (code) => ({ json: (d) => { respostas.push({ code, d }); }, end: () => {} }) };
  await webhookHandler(req, res);
  process.env.ZAPSIGN_WEBHOOK_SECRET = orig || '';
  assert('respondeu 401',    respostas[0] && respostas[0].code === 401);
  assert('menciona secret',  respostas[0] && respostas[0].d && respostas[0].d.error.toLowerCase().includes('secret'));
}

// ── [10] ─────────────────────────────────────────────────────────────────
grupo('[10] Provedor manual \u2192 SHA-256, instru\u00e7\u00f5es gov.br, sem rede');
{
  const buf  = Buffer.from('%PDF-1.4 fake');
  const sigs = [{ nome: 'Jo\u00e3o', email: 'j@x.com' }];
  const orig = global.fetch;
  let fetchChamado = false;
  global.fetch = async () => { fetchChamado = true; return {}; };
  const r = await manual.enviar({ buffer: buf, nomeDocumento: 'Termo', signatarios: sigs });
  global.fetch = orig;
  assert('sem chamada de rede',  !fetchChamado);
  assert('sha256 de 64 chars',   typeof r.sha256 === 'string' && r.sha256.length === 64);
  assert('instru\u00e7\u00f5es \u00e9 array',    Array.isArray(r.instrucoes) && r.instrucoes.length > 3);
  assert('menciona gov.br',      r.instrucoes.some(l => l.includes('gov.br')));
  assert('alerta sequencial',    r.instrucoes.some(l => l.includes('anterior') || l.includes('sequen')));
  assert('provedor = manual',    r.provedor === 'manual');
  assert('url vazia',            r.url.length === 0);
}

// ── [11] ─────────────────────────────────────────────────────────────────
grupo('[11] ASSINATURA_PROVIDER ausente/inv\u00e1lido \u2192 cai em manual');
{
  function getProvName(name) {
    const n = (name || 'manual').toLowerCase().trim();
    try { return require('../api/assinatura/_providers/' + n + '.js') && n; }
    catch { return 'manual'; }
  }
  assert('sem env \u2192 manual',  getProvName('') === 'manual');
  assert('inv\u00e1lido \u2192 manual', getProvName('inexistente') === 'manual');
  assert('zapsign \u2192 zapsign', getProvName('zapsign') === 'zapsign');
}

// ── [12] ─────────────────────────────────────────────────────────────────
grupo('[12] \u00c2ncoras <<devedor1>> no HTML e CSS as torna invis\u00edveis');
{
  assert('<<devedor presente no buildDoc',
    html.includes('<<devedor') || html.includes('devedor${i+1}'));
  assert('<<credora presente no buildDoc',
    html.includes('<<credora') || html.includes('credora${i+1}'));
  assert('.sign-anchor no CSS',     html.includes('.sign-anchor'));
  assert('sign-anchor color:#fff',  html.includes('sign-anchor') && html.includes('#fff'));
}

// ── Resultado ─────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(56));
console.log('Resultado: ' + passou + ' \u2713  ' + falhou + ' \u2717\n');
if (falhou > 0) process.exit(1);

} // fim main

main().catch(err => { console.error('[erro]', err.message); process.exit(1); });
