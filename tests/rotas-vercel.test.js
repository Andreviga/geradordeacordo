// tests/rotas-vercel.test.js — contrato de roteamento com o Vercel.
//
// Dois defeitos que só apareceram em produção e que estes testes travam:
//
// 1. Sub-rotas 404. O roteamento por sistema de arquivos do Vercel não entrega
//    /api/acordos/<uuid> para api/acordos/index.js — só o caminho exato. Medido
//    em produção: /api/acordos → 401, /api/acordos/<uuid> → 404. A correção são
//    rewrites declarados no vercel.json; estes testes garantem que eles existem,
//    que apontam para o recurso certo e que o handler lê o parâmetro que eles põem.
//
// 2. Crons respondendo 405. O scheduler do Vercel dispara com GET; os handlers
//    exigiam POST. Medido em produção: GET → 405, POST → 401. Resultado: nenhum
//    lembrete e nenhum backup jamais rodariam.

'use strict';
const fs   = require('fs');
const path = require('path');

let passou = 0, falhou = 0;
function grupo(t) { console.log(`\n${t}`); }
function assert(desc, cond) {
  if (cond) { passou++; console.log(`  ✓ ${desc}`); }
  else      { falhou++; console.log(`  ✗ ${desc}`); }
}

const raiz    = path.join(__dirname, '..');
const vercel  = JSON.parse(fs.readFileSync(path.join(raiz, 'vercel.json'), 'utf8'));
const { segmentosDaRota } = require('../api/_rota');

// ── [1] ───────────────────────────────────────────────────────────────────────
grupo('[1] vercel.json tem rewrite de sub-rota para cada recurso com sub-rotas');
{
  const rewrites = vercel.rewrites || [];
  for (const recurso of ['acordos', 'parcelas']) {
    const r = rewrites.find(x => x.source && x.source.startsWith(`/api/${recurso}/`));
    assert(`${recurso}: rewrite declarado`, !!r);
    if (!r) continue;
    assert(`${recurso}: captura o resto do caminho`, /:rota\*/.test(r.source));
    assert(`${recurso}: destino é o próprio recurso`, r.destination.startsWith(`/api/${recurso}?`));
    assert(`${recurso}: repassa o caminho em _rota`, /_rota=:rota\*/.test(r.destination));
    // A raiz não pode ser engolida pelo rewrite (o source exige um segmento a mais)
    assert(`${recurso}: rewrite não casa a raiz`, r.source !== `/api/${recurso}`);
  }
}

// ── [2] ───────────────────────────────────────────────────────────────────────
grupo('[2] segmentosDaRota lê as três origens possíveis');
{
  // Produção: o rewrite põe o caminho em _rota
  assert('_rota com um segmento',
    JSON.stringify(segmentosDaRota({ query: { _rota: 'abc-123' } }, 'acordos')) === '["abc-123"]');
  assert('_rota com dois segmentos',
    JSON.stringify(segmentosDaRota({ query: { _rota: 'abc-123/cancelar' } }, 'acordos')) === '["abc-123","cancelar"]');
  assert('_rota como array',
    JSON.stringify(segmentosDaRota({ query: { _rota: ['abc', 'baixar'] } }, 'parcelas')) === '["abc","baixar"]');

  // Runtime preenchendo params por conta própria
  assert('params do runtime',
    JSON.stringify(segmentosDaRota({ query: { params: ['abc', 'estornar'] } }, 'parcelas')) === '["abc","estornar"]');

  // Fallback por req.url (testes locais, vercel dev)
  assert('fallback por req.url',
    JSON.stringify(segmentosDaRota({ url: '/api/parcelas/xyz/baixar' }, 'parcelas')) === '["xyz","baixar"]');
  assert('fallback com querystring',
    JSON.stringify(segmentosDaRota({ url: '/api/acordos/xyz?busca=1' }, 'acordos')) === '["xyz"]');

  // Raiz do recurso → nenhum segmento (é o que separa listar de buscar)
  assert('raiz sem segmentos (url)',   JSON.stringify(segmentosDaRota({ url: '/api/acordos' }, 'acordos')) === '[]');
  assert('raiz sem segmentos (vazio)', JSON.stringify(segmentosDaRota({ query: {} }, 'acordos')) === '[]');
  assert('_rota vazio não vira segmento',
    JSON.stringify(segmentosDaRota({ query: { _rota: '' }, url: '/api/acordos' }, 'acordos')) === '[]');
}

// ── [3] ───────────────────────────────────────────────────────────────────────
grupo('[3] Os wrappers usam segmentosDaRota (e não parsing próprio de req.url)');
{
  for (const rel of ['api/acordos/index.js', 'api/parcelas/index.js']) {
    const src = fs.readFileSync(path.join(raiz, rel), 'utf8');
    assert(`${rel} usa segmentosDaRota`, src.includes('segmentosDaRota'));
  }
}

// ── [4] ───────────────────────────────────────────────────────────────────────
grupo('[4] Handlers de cron aceitam GET (é como o scheduler do Vercel dispara)');
{
  const agendados = (vercel.crons || []).map(c => c.path);
  assert('crons declarados no vercel.json', agendados.length > 0);

  // Teste de comportamento, não de texto: chama o handler com GET e sem segredo.
  // Tem que parar em 401 (chegou na verificação de auth) e nunca em 405 — e não
  // executa nada, porque o segredo não confere.
  const semSegredo = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const pendentes = [];
  for (const rel of ['api/cron/lembretes.js', 'api/cron/backup.js']) {
    const handler = require(path.join(raiz, rel));
    let status = null;
    const res = { status(c) { status = c; return this; }, json() { return this; }, end() { return this; } };
    pendentes.push(
      Promise.resolve(handler({ method: 'GET', headers: {} }, res)).then(() => {
        assert(`${rel}: GET não é recusado com 405`, status !== 405);
        assert(`${rel}: GET chega na verificação do segredo (401)`, status === 401);
      })
    );
    const src = fs.readFileSync(path.join(raiz, rel), 'utf8');
    assert(`${rel} exige CRON_SECRET`, src.includes('CRON_SECRET'));
  }
  Promise.all(pendentes).then(() => {
    if (semSegredo !== undefined) process.env.CRON_SECRET = semSegredo;
  });

  // Cada path agendado precisa existir como arquivo de função
  for (const p of agendados) {
    const semQuery = p.split('?')[0];
    const arq = path.join(raiz, semQuery.replace(/^\//, '') + '.js');
    const idx = path.join(raiz, semQuery.replace(/^\//, ''), 'index.js');
    assert(`${p} tem handler`, fs.existsSync(arq) || fs.existsSync(idx));
  }
}

// ── [5] ───────────────────────────────────────────────────────────────────────
grupo('[5] Comportamento real do wrapper com o payload do rewrite');
{
  // Simula o que o Vercel entrega depois do rewrite e confere que o handler
  // roteia para o ramo certo — sem auth, espera-se 401 (e não 404 de rota).
  const origSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret-32-chars-xxxxxxxxxxxxxxxxx';

  const wrapper = require('../api/parcelas/index.js');
  const req = {
    method: 'POST', headers: {}, body: {},
    url: '/api/parcelas?_rota=00000000-0000-0000-0000-000000000001/baixar',
    query: { _rota: '00000000-0000-0000-0000-000000000001/baixar' },
    setHeader: () => {},
  };
  let status = null;
  const res = { setHeader: () => {}, status(c) { status = c; return this; }, json() { return this; }, end() { return this; } };

  Promise.resolve(wrapper(req, res)).then(() => {
    assert('POST /api/parcelas/:id/baixar via rewrite → 401 (rota encontrada)', status === 401);
    assert('não caiu em 404 de rota', status !== 404);
    process.env.JWT_SECRET = origSecret;
    console.log(`\nResultado: ${passou} ✓  ${falhou} ✗`);
    if (falhou > 0) process.exit(1);
  });
}
