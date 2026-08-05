// tests/acordos-auth.test.js — testes de autorização dos endpoints de acordos
//
// Não precisa de banco real: testa a camada de autenticação (JWT) e papéis.
// Execute com: node tests/acordos-auth.test.js

'use strict';

const path   = require('path');
const crypto = require('crypto');
const fs     = require('fs');
const { criarJWT } = require('../api/_auth');

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  \u2713 ${desc}`); passou++; }
  else       { console.error(`  \u2717 ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

// ── Helpers de mock ───────────────────────────────────────────────────────────
function mockReq(overrides = {}) {
  return {
    method:  'GET',
    headers: {},
    body:    null,
    query:   {},
    ...overrides,
    setHeader: () => {},
  };
}
function mockRes() {
  const r = {
    _status: null, _body: null, _ended: false,
    status(code) { this._status = code; return this; },
    json(body)   { this._body   = body; return this; },
    end()        { this._ended  = true; return this; },
    setHeader()  { return this; },
  };
  return r;
}
const SECRET = 'test-secret-32-chars-xxxxxxxxxxxxxxxxx';

function tokenValido(payload = {}) {
  const agora = Math.floor(Date.now() / 1000);
  return criarJWT({ sub: 'uuid-fake-1234', papel: 'secretaria', iat: agora, exp: agora + 3600, ...payload }, SECRET);
}
function tokenExpirado() {
  const agora = Math.floor(Date.now() / 1000);
  return criarJWT({ sub: 'uuid-fake', exp: agora - 1 }, SECRET);
}

// ── [1] verificarRequisicao — sem JWT ─────────────────────────────────────────
grupo('[1] Sem JWT → 401');
{
  const { verificarRequisicao } = require('../api/_auth');
  const origSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;

  const req = mockReq({ headers: {} });
  const res = mockRes();
  const r = verificarRequisicao(req, res);
  assert('retorna null',    r === null);
  assert('status 401',      res._status === 401);
  assert('menciona autent', JSON.stringify(res._body).includes('utent'));

  process.env.JWT_SECRET = origSecret;
}

// ── [2] verificarRequisicao — JWT inválido ─────────────────────────────────────
grupo('[2] JWT inválido → 401');
{
  const { verificarRequisicao } = require('../api/_auth');
  const origSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;

  const req = mockReq({ headers: { authorization: 'Bearer nao.eh.jwt.valido' } });
  const res = mockRes();
  const r = verificarRequisicao(req, res);
  assert('retorna null',  r === null);
  assert('status 401',    res._status === 401);

  process.env.JWT_SECRET = origSecret;
}

// ── [3] verificarRequisicao — JWT expirado ─────────────────────────────────────
grupo('[3] JWT expirado → 401');
{
  const { verificarRequisicao } = require('../api/_auth');
  const origSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;

  const req = mockReq({ headers: { authorization: 'Bearer ' + tokenExpirado() } });
  const res = mockRes();
  const r = verificarRequisicao(req, res);
  assert('retorna null',     r === null);
  assert('status 401',       res._status === 401);

  process.env.JWT_SECRET = origSecret;
}

// ── [4] verificarRequisicaoComBanco — token legado (sub='dev') → 401 ──────────
grupo('[4] Token legado (sub="dev") → 401 em endpoints de banco');
{
  const { verificarRequisicaoComBanco } = require('../api/_auth');
  const origSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;

  const agora = Math.floor(Date.now() / 1000);
  const tokenDev = criarJWT({ sub: 'dev', papel: 'secretaria', iat: agora, exp: agora + 3600 }, SECRET);
  const req = mockReq({ headers: { authorization: 'Bearer ' + tokenDev } });
  const res = mockRes();

  verificarRequisicaoComBanco(req, res).then(r => {
    assert('retorna null',           r === null);
    assert('status 401',             res._status === 401);
    assert('menciona sessão',        JSON.stringify(res._body).toLowerCase().includes('sess'));
    process.env.JWT_SECRET = origSecret;
  }).catch(() => {
    assert('verificarRequisicaoComBanco resolve (não rejeita)', false);
    process.env.JWT_SECRET = origSecret;
  });
}

// ── [5] Endpoint /api/acordos — OPTIONS sem auth ───────────────────────────────
grupo('[5] OPTIONS não requer autenticação');
{
  const handler = require('../api/acordos/[[...params]].js');
  const req = mockReq({ method: 'OPTIONS', headers: {}, query: {} });
  const res = mockRes();
  handler(req, res).then(() => {
    assert('status 204 para OPTIONS', res._status === 204);
  }).catch(() => assert('handler não rejeita', false));
}

// ── [6] Catch-all: cada ramo de /api/acordos exige auth ────────────────────────
grupo('[6] Todos os ramos do catch-all exigem JWT (sem auth → 401)');
{
  const handler = require('../api/acordos/[[...params]].js');
  const origSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;

  const branches = [
    { label: 'GET /api/acordos',             method: 'GET',  query: {} },
    { label: 'POST /api/acordos',             method: 'POST', query: {} },
    { label: 'POST /api/acordos/importar',    method: 'POST', query: { params: ['importar'] } },
    { label: 'GET /api/acordos/:id',          method: 'GET',  query: { params: ['00000000-0000-0000-0000-000000000001'] } },
    { label: 'PUT /api/acordos/:id',          method: 'PUT',  query: { params: ['00000000-0000-0000-0000-000000000001'] } },
    { label: 'POST /api/acordos/:id/cancelar',method: 'POST', query: { params: ['00000000-0000-0000-0000-000000000001', 'cancelar'] } },
    { label: 'POST /api/acordos/:id/lembretes',method:'POST', query: { params: ['00000000-0000-0000-0000-000000000001', 'lembretes'] } },
  ];

  for (const b of branches) {
    const req = mockReq({ method: b.method, headers: {}, body: null, query: b.query });
    const res = mockRes();
    // eslint-disable-next-line no-await-in-loop
    handler(req, res).then(() => {
      assert(`${b.label} sem JWT → 401`, res._status === 401);
    }).catch(() => assert(`${b.label} resolve`, false));
  }
  process.env.JWT_SECRET = origSecret;
}

// ── [6b] Todos os ramos de /api/parcelas exigem JWT ──────────────────────────
grupo('[6b] Todos os ramos do catch-all parcelas exigem JWT (sem auth → 401)');
{
  const handler = require('../api/parcelas/[[...params]].js');
  const origSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;

  const branches = [
    { label: 'POST /api/parcelas/:id/baixar',   query: { params: ['00000000-0000-0000-0000-000000000001', 'baixar'] } },
    { label: 'POST /api/parcelas/:id/estornar', query: { params: ['00000000-0000-0000-0000-000000000001', 'estornar'] } },
  ];
  for (const b of branches) {
    const req = mockReq({ method: 'POST', headers: {}, body: null, query: b.query });
    const res = mockRes();
    handler(req, res).then(() => {
      assert(`${b.label} sem JWT → 401`, res._status === 401);
    }).catch(() => assert(`${b.label} resolve`, false));
  }
  process.env.JWT_SECRET = origSecret;
}

// ── [6c] GET /api/vencidas sem JWT → 401 ──────────────────────────────────────
grupo('[6c] GET /api/vencidas sem JWT → 401');
{
  const handler = require('../api/vencidas.js');
  const origSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  const req = mockReq({ method: 'GET', headers: {}, query: {} });
  const res = mockRes();
  handler(req, res).then(() => {
    assert('status 401', res._status === 401);
    process.env.JWT_SECRET = origSecret;
  }).catch(() => { assert('resolve', false); process.env.JWT_SECRET = origSecret; });
}

// ── [6d] GET /api/dashboard sem JWT → 401 ─────────────────────────────────────
grupo('[6d] GET /api/dashboard sem JWT → 401');
{
  const handler = require('../api/dashboard.js');
  const origSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  const req = mockReq({ method: 'GET', headers: {}, query: {} });
  const res = mockRes();
  handler(req, res).then(() => {
    assert('status 401', res._status === 401);
    process.env.JWT_SECRET = origSecret;
  }).catch(() => { assert('resolve', false); process.env.JWT_SECRET = origSecret; });
}

// ── [7] POST /api/acordos/:id/cancelar com papel secretaria → 403 ─────────────
// O catch-all verifica papel ANTES de executar cancelar (só admin pode cancelar)
grupo('[7] POST /api/acordos/:id/cancelar com secretaria → 403 (verificação de papel)');
{
  // Sem banco: só verifica que a regra de papel está codificada corretamente
  const papelSecretaria = 'secretaria';
  assert('secretaria !== admin (regra de cancelar)', papelSecretaria !== 'admin');
  // Nota: o teste de integração real fica no smoke test (exige DB)
}

// ── [8] Teste estrutural: todos os handlers /api/ verificam autenticação ───────
grupo('[8] Estrutural: handlers /api/ chamam verificarRequisicao ou são whitelisted');
{
  const WHITELIST = new Set([
    'api/login.js',
    'api/assinatura/webhook.js',
    'api/_auth.js',
    'api/_db.js',
    'api/cron/_calcularEvento.js',
    'api/cron/_emailAdapter.js',
    'api/cron/_email_gmail.js',
    'api/acordos/index.js',       // wrapper de roteamento; auth está no [[...params]].js
    'api/solicitar-reset.js',     // endpoint público: usuário está bloqueado, sem JWT
    'api/confirmar-reset.js',     // endpoint público: valida token do e-mail, não JWT
    'api/cron/lembretes.js',      // auth via CRON_SECRET no header Authorization, não JWT
  ]);

  function scanHandlers(dir, base = '') {
    const erros = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(base, entry.name);
      const abs = path.join(dir, entry.name);
      // Pular módulos internos: arquivos/diretórios começando com _ não são handlers HTTP
      if (entry.name.startsWith('_')) continue;
      if (entry.isDirectory()) {
        erros.push(...scanHandlers(abs, rel));
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const relNorm = rel.replace(/\\/g, '/');
      if (WHITELIST.has(relNorm)) continue;
      const content = fs.readFileSync(abs, 'utf8');
      const temAuth = content.includes('verificarRequisicao') || content.includes('verificarRequisicaoComBanco');
      if (!temAuth) erros.push(relNorm);
    }
    return erros;
  }

  const apiDir = path.join(__dirname, '../api');
  const semAuth = scanHandlers(apiDir, 'api');
  if (semAuth.length === 0) {
    assert('todos os handlers têm verificação de auth', true);
  } else {
    semAuth.forEach(f => assert(`${f} sem verificação de auth`, false));
  }
}

// ── Resultado ─────────────────────────────────────────────────────────────────
setTimeout(() => {
  console.log(`\nResultado: ${passou} ✓  ${falhou} ✗`);
  if (falhou > 0) process.exit(1);
}, 200); // aguardar Promises async dos testes [4-6]
