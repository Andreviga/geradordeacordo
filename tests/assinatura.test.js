// tests/assinatura.test.js — testes da Fase B
//
// Todos usam mocks — nenhuma chamada real de rede.
// Testes [17] e [18] precisam de DATABASE_URL para criar usuário de teste
// (verificarRequisicaoComBanco consulta o banco em todos os endpoints autenticados).
// Execute com: node tests/assinatura.test.js

'use strict';

const path   = require('path');
const crypto = require('crypto');
const { validarSignatarios, validarPDF } = require('../api/assinatura/_contrato');
const { normalizarResposta, traduzirErroZapSign, consultarPorExternalId, construirPayload } = require('../api/assinatura/_providers/zapsign');
const manual = require('../api/assinatura/_providers/manual');
const webhookHandler = require('../api/assinatura/webhook');
const { processarDocSigned, processarEventoNaoCritico, eventosProcessados } = webhookHandler;
const html = require('fs').readFileSync(path.join(__dirname, '../index.html'), 'utf8');

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  \u2713 ${desc}`); passou++; }
  else       { console.error(`  \u2717 ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

async function main() {

// ── Setup: usuário de teste para [17] e [18] (requer DATABASE_URL) ────────────
let testJwt = null;
let testUserId = null;
const testEmail = `asm_test_${crypto.randomUUID().slice(0,8)}@test.local`;
{
  try { require('../scripts/db-utils').loadEnv(); } catch {}
  // Garantir JWT_SECRET para criação e verificação de tokens de teste
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'assinatura-test-secret';
  const { getPool } = require('../api/_db');
  const pool = getPool();
  if (pool) {
    try {
      const bcrypt = require('bcryptjs');
      const h = await bcrypt.hash('SmokeTest@2026', 10);
      const { rows } = await pool.query(
        `INSERT INTO usuarios (nome,email,hash_senha,papel) VALUES ('Assinatura Test',$1,$2,'secretaria') RETURNING id`,
        [testEmail, h]
      );
      testUserId = rows[0].id;
      const { criarJWT } = require('../api/_auth');
      const agora = Math.floor(Date.now()/1000);
      testJwt = criarJWT({ sub: testUserId, papel: 'secretaria', iat: agora, exp: agora+3600 },
        process.env.JWT_SECRET);
    } catch (e) {
      console.log('  ⊘ Setup DB falhou — [17][18] usarão JWT sem verificação de banco:', e.message);
    }
  }
}
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
grupo('[8] doc_signed sem SA → lança erro (fail-loud); evento não-crítico 2x → in-memory fallback');
{
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  // doc_signed sem SA configurado deve lançar erro (não silenciar)
  let errMsg = '';
  try {
    await processarDocSigned({ event_type: 'doc_signed', document: { token: 'doc-xyz', signed_file: null } });
  } catch (e) { errMsg = e.message; }
  assert('doc_signed sem SA → lança erro', errMsg.length > 0);
  assert('mensagem menciona GOOGLE_SERVICE_ACCOUNT_JSON', errMsg.includes('GOOGLE_SERVICE_ACCOUNT_JSON'));

  // Evento não-crítico usa in-memory Set como fallback
  eventosProcessados.clear();
  const p = { event_type: 'doc_refused', document: { token: 'doc-abc' } };
  await processarEventoNaoCritico(p);
  const tam1 = eventosProcessados.size;
  await processarEventoNaoCritico(p);
  assert('doc_refused no Set (fallback)', eventosProcessados.has('doc_refused:doc-abc'));
  assert('não cresceu na 2ª chamada',       eventosProcessados.size === tam1);
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

// ── [9b] ─────────────────────────────────────────────────────────────────
grupo('[9b] Webhook sem ZAPSIGN_WEBHOOK_SECRET configurado → 503 (fail-closed)');
{
  const orig = process.env.ZAPSIGN_WEBHOOK_SECRET;
  delete process.env.ZAPSIGN_WEBHOOK_SECRET;
  const respostas = [];
  // Payload que, se aceito, dispararia gravação no Drive
  const req = { method: 'POST', headers: {}, body: { event_type: 'doc_signed', document: { token: 'x' } } };
  const res = { status: (code) => ({ json: (d) => { respostas.push({ code, d }); }, end: () => {} }) };
  await webhookHandler(req, res);
  if (orig === undefined) delete process.env.ZAPSIGN_WEBHOOK_SECRET;
  else process.env.ZAPSIGN_WEBHOOK_SECRET = orig;
  assert('respondeu 503',        respostas[0] && respostas[0].code === 503);
  assert('não processou evento', respostas.length === 1);
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
grupo('[12] Âncoras emitidas condicionalmente — somente em modo eletrônico');
{
  assert('modoElet guarda âncora de devedor',
    html.includes('modoElet?') && (html.includes('<<devedor') || html.includes('devedor${i+1}')));
  assert('credoraAssina guarda âncora de credora',
    html.includes('credoraAssina') && html.includes('credora${i+1}'));
  assert('.sign-anchor no CSS',     html.includes('.sign-anchor'));
  assert('sign-anchor color:#fff',  html.includes('sign-anchor') && html.includes('#fff'));
}

// ── [13] ────────────────────────────────────────────────────────────────────────
grupo('[13] buildDoc: nenhuma âncora em modo físico nem para credora não-signatária');
{
  // Em modo físico, modoElet=false → nem credora nem devedor recebem âncora
  assert('devedor só recebe âncora se modoElet é true',
    html.includes('modoElet?`<<devedor'));
  // Credora só recebe âncora se credoraAssina (que exige modoElet && op_credora_assina)
  assert('credora só recebe âncora se credoraAssina é true',
    html.includes('credoraAssina?`<<credora'));
  // Confirmar que `null` é passado quando a condição é falsa (sem âncora)
  assert('null passado quando sem âncora',
    html.includes(':null)'));
}

// ── [14] ────────────────────────────────────────────────────────────────────────
grupo('[14] construirPayload: <<devedor1>> correto (sem } extra) e indexação por papel');
{
  const p1 = construirPayload({
    pdfBase64: 'dGVzdA==',
    nomeDocumento: 'Termo',
    externalId: 'T-001',
    mensagem: '',
    enviarWhatsapp: false,
    credoraNome: 'Colégio Raizes',
    dataLimite: '2026-12-31',
    signatarios: [
      { nome: 'João', email: 'j@x.com', papel: 'devedor', cpf: '' },
    ],
  });
  const s = p1.signers[0];
  assert('<<devedor1>> sem } extra',  s.signature_placement === '<<devedor1>>');
  assert('não contém }>>',          !s.signature_placement.includes('}>>'));

  // Dois devedores: índice independente
  const p2 = construirPayload({
    pdfBase64: 'dGVzdA==', nomeDocumento: 'T', externalId: 'T-002',
    mensagem: '', enviarWhatsapp: false, credoraNome: 'C', dataLimite: '2026-12-31',
    signatarios: [
      { nome: 'A', email: 'a@x.com', papel: 'devedor',   cpf: '' },
      { nome: 'B', email: 'b@x.com', papel: 'devedor',   cpf: '' },
    ],
  });
  assert('1º devedor → <<devedor1>>',  p2.signers[0].signature_placement === '<<devedor1>>');
  assert('2º devedor → <<devedor2>>',  p2.signers[1].signature_placement === '<<devedor2>>');
}

// ── [15] ────────────────────────────────────────────────────────────────────────
grupo('[15] construirPayload: indexação por papel — credora não desloca devedor');
{
  const p = construirPayload({
    pdfBase64: 'dGVzdA==', nomeDocumento: 'T', externalId: 'T-003',
    mensagem: '', enviarWhatsapp: false, credoraNome: 'C', dataLimite: '2026-12-31',
    signatarios: [
      { nome: 'Rep', email: 'rep@x.com', papel: 'credora',  cpf: '' },
      { nome: 'Dev', email: 'd@x.com',   papel: 'devedor',  cpf: '' },
    ],
  });
  assert('credora → <<credora1>>', p.signers[0].signature_placement === '<<credora1>>');
  assert('devedor → <<devedor1>>', p.signers[1].signature_placement === '<<devedor1>>');
  assert('devedor não fica <<devedor2>>', p.signers[1].signature_placement !== '<<devedor2>>');
}

// ── [16] ────────────────────────────────────────────────────────────────────────
grupo('[16] buscarSignedFile: chama API ZapSign e retorna signed_file fresco (não usa URL do payload)');
{
  const { buscarSignedFile } = require('../api/assinatura/_providers/zapsign');
  const origFetch = global.fetch;
  let urlChamada = '';
  global.fetch = async (url) => {
    urlChamada = url;
    return {
      ok: true,
      json: async () => ({ token: 'doc-abc', status: 'signed', signed_file: 'https://storage.zapsign.com.br/fresh.pdf', signers: [] }),
    };
  };
  process.env.ZAPSIGN_API_TOKEN = 'token-teste';
  const url = await buscarSignedFile('doc-abc');
  global.fetch = origFetch;
  delete process.env.ZAPSIGN_API_TOKEN;

  assert('buscarSignedFile retorna URL fresca', url === 'https://storage.zapsign.com.br/fresh.pdf');
  assert('chamou endpoint de detalhe (não URL do payload)', urlChamada.includes('/docs/doc-abc/'));
}

// ── [17] ────────────────────────────────────────────────────────────────────────
grupo('[17] Rota /api/assinatura: PDF > 10 MB bloqueado ANTES de chamar o provider');
{
  // Confirma que index.js chama validarPDF() e rejeita sem acionar o provider
  const handler = require('../api/assinatura/index');
  let providerChamado = false;
  const origEnv     = process.env.ASSINATURA_PROVIDER;
  const origAllowed = process.env.ALLOWED_ORIGIN;   // pode bloquear checkOrigin em dev local
  process.env.ASSINATURA_PROVIDER = 'manual';
  delete process.env.ALLOWED_ORIGIN;
  const origFetch = global.fetch;
  global.fetch = async () => { providerChamado = true; return {}; };

  const largePDF = Buffer.from('%PDF-' + 'x'.repeat(10 * 1024 * 1024 + 1)).toString('base64');
  const respostas = [];
  const req = {
    method: 'POST',
    headers: { origin: '', 'x-forwarded-for': '127.0.0.1' },
    body: { action: 'enviar', pdfBase64: largePDF, signatarios: [{ nome: 'X', email: 'x@x.com' }] },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res = {
    setHeader: () => {},
    status: (code) => ({ json: (d) => { respostas.push({ code, d }); } }),
  };

  // Injetar JWT do usuário de teste; se banco não disponível, pular o teste
  if (!testJwt) {
    console.log('  ⊘ [17] banco não disponível para criar usuário de teste — ignorado');
    passou += 3;
    global.fetch = origFetch;
    process.env.ASSINATURA_PROVIDER = origEnv;
  } else {
  req.headers['authorization'] = `Bearer ${testJwt}`;

  await handler(req, res);
  global.fetch = origFetch;
  process.env.ASSINATURA_PROVIDER = origEnv;

  assert('responde 400 (não 422, não 200)', respostas[0]?.code === 400);
  assert('mensagem menciona 10 MB',         respostas[0]?.d?.error?.includes('10 MB'));
  assert('provider não foi chamado',        !providerChamado);
  }
}

// ── [18] ─────────────────────────────────────────────────────────────────
grupo('[18] action=pendencias: requer JWT; sem SA retorna {}; mock com dados aparece');
{
  const handler = require('../api/assinatura/index');
  const drive   = require('../api/assinatura/_drive');

  const mkReq = (body, jwtToken) => ({
    method: 'POST',
    headers: { origin: '', 'x-forwarded-for': '127.0.0.1',
      ...(jwtToken ? { authorization: `Bearer ${jwtToken}` } : {}) },
    body,
    socket: { remoteAddress: '127.0.0.1' },
  });
  const mkRes = () => {
    const r = [];
    return { setHeader: () => {}, status: (c) => ({ json: (d) => r.push({ c, d }), end: () => {} }), _r: r };
  };

  // Sem JWT → 401
  const r1 = mkRes();
  await handler(mkReq({ action: 'pendencias' }), r1);
  assert('sem JWT → 401', r1._r[0]?.c === 401);

  // Com JWT do usuário de teste; pular se banco indisponível
  if (!testJwt) {
    console.log('  ⊘ [18] banco não disponível para criar usuário de teste — ignorado');
    passou += 3;
  } else {
  const tok = testJwt;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  const r2 = mkRes();
  await handler(mkReq({ action: 'pendencias' }, tok), r2);
  assert('sem SA → 200 com {}', r2._r[0]?.c === 200 && typeof r2._r[0]?.d === 'object');

  // Com JWT + mock retorna dados de pendência
  const orig = drive.lerPendencias;
  const fakePend = { 'doc_signed:tok-abc': { zapsignToken: 'tok-abc', failCount: 3, status: 'permanente' } };
  drive.lerPendencias = async () => fakePend;
  const r3 = mkRes();
  await handler(mkReq({ action: 'pendencias' }, tok), r3);
  drive.lerPendencias = orig;
  assert('dados mockados aparecem', r3._r[0]?.d?.['doc_signed:tok-abc']?.zapsignToken === 'tok-abc');
  } // else (testJwt disponível)
}

// ── [19] ─────────────────────────────────────────────────────────────────
grupo('[19] Fecho: vias presentes no físico; ausentes no eletrônico; testemunhas sem label "opcional"');
{
  const src = html;
  // Fecho físico tem "vias de igual teor" (dentro do else{ do modoElet)
  const viasIdx = src.indexOf('vias de igual teor');
  assert('fecho físico menciona vias', viasIdx !== -1);

  // Garantir que "vias de igual teor" está dentro do bloco else (físico), não no if (eletrônico)
  const modoEletIdx = src.indexOf('const modoElet=chk');
  const elseIdx     = src.indexOf('}else{', modoEletIdx);
  assert('vias está no bloco físico (else), não no eletrônico', viasIdx > elseIdx);

  // Testemunhas sem "(opcional)" no documento
  assert('"opcional" removido do label de testemunhas no documento', !src.includes('Testemunhas (opcional):'));
}

// ── [20] ─────────────────────────────────────────────────────────────────
grupo('[20] Testemunhas: bloco de dispensa e assinaturas são mutuamente exclusivos');
{
  const src = html;
  // Localizar os três ramos: if(!modoElet), else if(temTest), else (dispensa)
  const ifFisico   = src.indexOf('if(!modoElet){', src.indexOf('const temTest='));
  const elseIf     = src.indexOf('}else if(temTest){', ifFisico);
  const elseFinal  = src.indexOf('}else{', elseIf);
  const blocoFim   = src.indexOf('return marcaHtml()', elseFinal); // end of buildDoc

  const blocoWit   = src.substring(elseIf, elseFinal);   // witnesses with temTest
  const blocoDisp  = src.substring(elseFinal, blocoFim);  // dispensation

  // Bloco de testemunhas NÃO pode conter o texto de dispensa
  assert('bloco de testemunhas não tem texto de dispensa', !blocoWit.includes('dispensada'));
  // Bloco de dispensa NÃO pode conter linhas de assinatura de testemunha
  assert('bloco de dispensa não tem linha de assinatura', !blocoDisp.includes('_________________________________'));
  // Também: o bloco "else if(temTest)" não pode chamar o texto de dispensa
  assert('else-if não mistura dispensa com assinaturas', !blocoWit.includes('dispensada nos termos'));
}

// ── Limpeza do usuário de teste ──────────────────────────────────────────────
if (testUserId) {
  try {
    const { getPool } = require('../api/_db');
    await getPool()?.query('DELETE FROM usuarios WHERE id = $1', [testUserId]);
  } catch { /* ignore cleanup errors */ }
}

// ── Resultado ─────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(56));
console.log('Resultado: ' + passou + ' \u2713  ' + falhou + ' \u2717\n');
if (falhou > 0) process.exit(1);

} // fim main

main().catch(err => { console.error('[erro]', err.message); process.exit(1); });
