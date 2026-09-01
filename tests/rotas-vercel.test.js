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
    const um   = rewrites.find(x => x.source === `/api/${recurso}/:seg1`);
    const dois = rewrites.find(x => x.source === `/api/${recurso}/:seg1/:seg2`);

    assert(`${recurso}: rewrite de 1 segmento`,  !!um);
    assert(`${recurso}: rewrite de 2 segmentos`, !!dois);
    if (!um || !dois) continue;

    assert(`${recurso}: 1 segmento vai para o recurso`,  um.destination   === `/api/${recurso}?_seg1=:seg1`);
    assert(`${recurso}: 2 segmentos vão para o recurso`, dois.destination === `/api/${recurso}?_seg1=:seg1&_seg2=:seg2`);

    // Segmento repetido (:x*) na querystring do destino é recusado pelo
    // path-to-regexp do Vercel — "Can not repeat without a prefix and suffix".
    // O build passa mesmo assim e só quebra em execução, então travar aqui.
    for (const r of rewrites)
      assert(`sem parâmetro repetido em "${r.destination}"`, !/:[A-Za-z_]+\*/.test(r.destination.split('?')[1] || ''));

    // A raiz não pode ser engolida: o source sempre exige ao menos um segmento
    assert(`${recurso}: rewrite não casa a raiz`,
      !rewrites.some(x => x.source === `/api/${recurso}`));
  }
}

// ── [2] ───────────────────────────────────────────────────────────────────────
grupo('[2] segmentosDaRota lê as três origens possíveis');
{
  // Produção: o rewrite põe o caminho em _rota
  assert('_seg1 com um segmento',
    JSON.stringify(segmentosDaRota({ query: { _seg1: 'abc-123' } }, 'acordos')) === '["abc-123"]');
  assert('_seg1 + _seg2',
    JSON.stringify(segmentosDaRota({ query: { _seg1: 'abc-123', _seg2: 'cancelar' } }, 'acordos')) === '["abc-123","cancelar"]');
  assert('segmentos com barra em _seg1',
    JSON.stringify(segmentosDaRota({ query: { _seg1: 'abc', _seg2: 'baixar' } }, 'parcelas')) === '["abc","baixar"]');

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
  assert('_seg1 vazio não vira segmento',
    JSON.stringify(segmentosDaRota({ query: { _seg1: '' }, url: '/api/acordos' }, 'acordos')) === '[]');
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

  // Teste de comportamento, não de texto. Duas causas diferentes precisam de
  // respostas diferentes: sem CRON_SECRET no servidor é erro de configuração
  // (503); com segredo configurado e header errado é credencial (401).
  // Quando as duas davam 401, uma execução que falhava não dizia qual era —
  // e o backup passou semanas sem rodar sem que se soubesse por quê.
  const semSegredo = process.env.CRON_SECRET;
  const pendentes = [];
  const cronHandler = require(path.join(raiz, 'api/cron/index.js'));
  const chamar = (headers, query) => {
    let status = null;
    const res = { status(c) { status = c; return this; }, json() { return this; }, end() { return this; } };
    return Promise.resolve(cronHandler({ method: 'GET', headers, query }, res)).then(() => status);
  };

  delete process.env.CRON_SECRET;
  for (const job of ['lembretes', 'backup', 'retencao']) {
    pendentes.push(chamar({}, { job }).then(status => {
      assert(`cron ${job}: GET não é recusado com 405`, status !== 405);
      assert(`cron ${job}: sem CRON_SECRET no servidor → 503, não 401`, status === 503);
    }));
  }

  process.env.CRON_SECRET = 'segredo-de-teste';
  pendentes.push(chamar({}, { job: 'backup' }).then(status =>
    assert('com segredo configurado e header ausente → 401', status === 401)));
  pendentes.push(chamar({ authorization: 'Bearer errado' }, { job: 'backup' }).then(status =>
    assert('segredo errado → 401', status === 401)));
  // A pegadinha que motivou o trim: segredo colado no painel com quebra de linha
  pendentes.push((async () => {
    process.env.CRON_SECRET = 'segredo-de-teste\n';
    const status = await chamar({ authorization: 'Bearer segredo-de-teste' }, { job: 'inventado' });
    process.env.CRON_SECRET = 'segredo-de-teste';
    assert('segredo com quebra de linha no fim ainda casa (trim dos dois lados)', status === 404);
  })());
  // Job desconhecido só é revelado depois da auth
  pendentes.push(chamar({}, { job: 'inventado' }).then(status =>
    assert('job inexistente não vaza antes da auth (401, não 404)', status === 401)));
  const srcCron = fs.readFileSync(path.join(raiz, 'api/cron/index.js'), 'utf8');
  assert('api/cron/index.js exige CRON_SECRET', srcCron.includes('CRON_SECRET'));
  // O nome do job precisa sobreviver mesmo se o rewrite não preencher a query
  assert('jobDaRota lê do rewrite',   cronHandler.jobDaRota({ query: { job: 'backup' } }) === 'backup');
  assert('jobDaRota cai para req.url', cronHandler.jobDaRota({ url: '/api/cron/lembretes' }) === 'lembretes');
  Promise.all(pendentes).then(() => {
    if (semSegredo !== undefined) process.env.CRON_SECRET = semSegredo;
  });

  // Cada path agendado precisa existir como arquivo de função
  for (const p of agendados) {
    const semQuery = p.split('?')[0];
    const arq = path.join(raiz, semQuery.replace(/^\//, '') + '.js');
    const idx = path.join(raiz, semQuery.replace(/^\//, ''), 'index.js');

    // O caminho agendado pode ser servido direto por um arquivo OU chegar lá por
    // um rewrite — é o caso de /api/cron/lembretes, que o vercel.json reescreve
    // para /api/cron?job=lembretes desde que os dois crons viraram uma função só.
    const porRewrite = (vercel.rewrites || []).some(rw => {
      const re = new RegExp('^' + rw.source.replace(/:[A-Za-z0-9_]+\*/g, '.+').replace(/:[A-Za-z0-9_]+/g, '[^/]+') + '$');
      if (!re.test(semQuery)) return false;
      const destino = rw.destination.split('?')[0].replace(/^\//, '');
      return fs.existsSync(path.join(raiz, destino + '.js'))
          || fs.existsSync(path.join(raiz, destino, 'index.js'));
    });

    assert(`${p} tem handler (arquivo ou rewrite)`, fs.existsSync(arq) || fs.existsSync(idx) || porRewrite);
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
    url: '/api/parcelas?_seg1=00000000-0000-0000-0000-000000000001&_seg2=baixar',
    query: { _seg1: '00000000-0000-0000-0000-000000000001', _seg2: 'baixar' },
    setHeader: () => {},
  };
  let status = null;
  const res = { setHeader: () => {}, status(c) { status = c; return this; }, json() { return this; }, end() { return this; } };

  Promise.resolve(wrapper(req, res)).then(() => {
    assert('POST /api/parcelas/:id/baixar via rewrite → 401 (rota encontrada)', status === 401);
    assert('não caiu em 404 de rota', status !== 404);
    process.env.JWT_SECRET = origSecret;

    limiteDeFuncoes();

    console.log(`\nResultado: ${passou} ✓  ${falhou} ✗`);
    if (falhou > 0) process.exit(1);
  });
}

// ── [6] ───────────────────────────────────────────────────────────────────────
// O plano Hobby do Vercel recusa o deployment inteiro acima de 12 funções
// serverless, e a mensagem só aparece no log de build — depois do push, com o
// deploy já falhado. Isto falha antes, aqui.
function limiteDeFuncoes() {
  grupo('[6] Limite de funções serverless do plano Hobby');
  const LIMITE = 12;

  const funcoes = [];
  (function varrer(dir, base = '') {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entrada.name}` : entrada.name;
      if (entrada.isDirectory()) { varrer(path.join(dir, entrada.name), rel); continue; }
      if (!entrada.name.endsWith('.js')) continue;
      // Arquivos com prefixo _ são módulos privados: o Vercel não os transforma
      // em função, e é justamente por isso que os catch-all viraram _handler.js.
      if (rel.split('/').some(p => p.startsWith('_'))) continue;
      funcoes.push('api/' + rel);
    }
  })(path.join(raiz, 'api'));

  assert(`${funcoes.length} função(ões) — no máximo ${LIMITE}`, funcoes.length <= LIMITE);
  if (funcoes.length > LIMITE) {
    console.error('    O build do Vercel vai falhar. Funções encontradas:');
    funcoes.forEach(f => console.error('      ' + f));
    console.error('    Funda rotas irmãs numa função só (ex.: api/painel.js, api/cron/index.js).');
  } else if (funcoes.length === LIMITE) {
    console.log(`    ⚠  no teto: o próximo endpoint quebra o build`);
  } else {
    console.log(`    folga: ${LIMITE - funcoes.length} slot(s)`);
  }
}
