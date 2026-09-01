// tests/correcoes.test.js — quatro defeitos apontados na revisão do sistema.
//
//   [1] CORS aceitava por prefixo — dominio-falso podia se passar pelo real
//   [2] Cold start do Neon derrubava o primeiro login com 503
//   [3] Cada salvamento duplicava os alunos
//   [4] Listagem cortava em 100 sem avisar que havia mais
//
// Os dois últimos precisam de banco, então rodam contra PostgreSQL real (PGlite).

'use strict';

const fs   = require('fs');
const path = require('path');

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else      { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

const SECRET = 'test-secret-32-chars-xxxxxxxxxxxxxxxxx';
const USER   = '00000000-0000-4000-8000-000000000001';

function mockRes() {
  return {
    _status: null, _body: null, _headers: {},
    status(c) { this._status = c; return this; },
    json(b)   { this._body = b;   return this; },
    end()     { return this; },
    setHeader(k, v) { this._headers[k.toLowerCase()] = v; return this; },
  };
}

async function main() {
  // ── [1] CORS por comparação exata ────────────────────────────────────────
  grupo('[1] CORS não aceita mais por prefixo');
  {
    const { applyCors } = require('../api/_auth');
    const orig = process.env.ALLOWED_ORIGIN;
    process.env.ALLOWED_ORIGIN = 'https://gerador-acordo.vercel.app';

    const testar = (origin) => {
      const res = mockRes();
      applyCors({ headers: { origin } }, res);
      return res._headers['access-control-allow-origin'];
    };

    assert('origem legítima é liberada',
      testar('https://gerador-acordo.vercel.app') === 'https://gerador-acordo.vercel.app');
    assert('sufixo malicioso é recusado (era o furo)',
      testar('https://gerador-acordo.vercel.app.dominio-do-atacante.com') === undefined);
    assert('subdomínio parecido é recusado',
      testar('https://gerador-acordo.vercel.app.evil.io') === undefined);
    assert('outra origem qualquer é recusada',
      testar('https://outro-site.com') === undefined);
    assert('barra final não muda o resultado',
      testar('https://gerador-acordo.vercel.app/') === 'https://gerador-acordo.vercel.app/');

    process.env.ALLOWED_ORIGIN = 'https://a.com, https://gerador-acordo.vercel.app';
    assert('lista com várias origens continua funcionando',
      testar('https://gerador-acordo.vercel.app') === 'https://gerador-acordo.vercel.app');

    if (orig === undefined) delete process.env.ALLOWED_ORIGIN;
    else process.env.ALLOWED_ORIGIN = orig;
  }

  // ── [2] Retry só quando a conexão nem abriu ──────────────────────────────
  grupo('[2] Retry de cold start distingue falha ao conectar de erro no meio');
  {
    const { ehFalhaAoConectar } = require('../api/_db');
    assert('timeout ao conectar → repete',
      ehFalhaAoConectar({ message: 'timeout exceeded when trying to connect' }) === true);
    assert('ECONNREFUSED → repete',  ehFalhaAoConectar({ code: 'ECONNREFUSED' }) === true);
    assert('ENOTFOUND → repete',     ehFalhaAoConectar({ code: 'ENOTFOUND' })   === true);
    // Estes NÃO podem repetir: o comando pode ter rodado, e repetir gravaria duas vezes
    assert('conexão derrubada no meio → NÃO repete',
      ehFalhaAoConectar({ message: 'Connection terminated unexpectedly' }) === false);
    assert('erro de constraint → NÃO repete', ehFalhaAoConectar({ code: '23505' }) === false);
    assert('erro de sintaxe → NÃO repete',    ehFalhaAoConectar({ code: '42601' }) === false);
  }

  // ── Banco real para os dois seguintes ────────────────────────────────────
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  await db.waitReady;
  await db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));

  const caminhoDb = require.resolve('../api/_db');
  require('../api/_db');
  const dbReal = require.cache[caminhoDb].exports;
  require.cache[caminhoDb].exports = {
    ...dbReal,
    getPool: () => db,
    withTransaction: async (fn) => {
      await db.query('BEGIN');
      try { const r = await fn(db); await db.query('COMMIT'); return r; }
      catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
    },
    isDbUnavailable: () => false,
  };

  process.env.JWT_SECRET = SECRET;
  const { criarJWT } = require('../api/_auth');
  const handler = require('../api/acordos/_handler');
  const agora = Math.floor(Date.now() / 1000);
  const token = criarJWT({ sub: USER, papel: 'admin', email: 'a@x.com', iat: agora, exp: agora + 3600 }, SECRET);

  await db.query(`INSERT INTO usuarios (id,nome,email,hash_senha,papel,ativo)
                  VALUES ($1,'Admin','a@x.com','$2a$10$h','admin',true)`, [USER]);

  const chamar = async (method, query, body) => {
    const res = mockRes();
    await handler({ method, query, body, headers: { authorization: 'Bearer ' + token }, url: '/api/acordos', setHeader() {} }, res);
    return res;
  };

  const corpoAcordo = (alunos) => ({
    devedores: [{ nome: 'Fulano', cpf: '11144477735' }],
    alunos,
    parcelas: [{ numero: 1, vencimento: '2027-01-10', valorPrevistoCts: 50000 }],
    acordo: { valorTotalCts: 50000 },
  });

  // ── [3] Alunos deixam de duplicar ────────────────────────────────────────
  grupo('[3] Salvar duas vezes não duplica o aluno');
  {
    let r = await chamar('POST', {}, corpoAcordo([{ nome: 'Thiago Augusto', serie: '3ª série', ra: 'RA-100' }]));
    assert('primeiro acordo salvo', r._status === 201);
    r = await chamar('POST', {}, corpoAcordo([{ nome: 'Thiago Augusto', serie: '4ª série', ra: 'RA-100' }]));
    assert('segundo acordo salvo', r._status === 201);

    let { rows } = await db.query(`SELECT id, serie FROM alunos WHERE ra = 'RA-100'`);
    assert('mesmo RA → um único cadastro', rows.length === 1);
    assert('série foi atualizada para o ano corrente', rows[0].serie === '4ª série');

    // Sem RA: dedup por nome + série
    await chamar('POST', {}, corpoAcordo([{ nome: 'Sem Ra', serie: '1º ano' }]));
    await chamar('POST', {}, corpoAcordo([{ nome: 'SEM RA', serie: '1º ano' }]));
    ({ rows } = await db.query(`SELECT id FROM alunos WHERE LOWER(nome) = 'sem ra'`));
    assert('sem RA, mesmo nome e série → um cadastro', rows.length === 1);

    // Nomes iguais em séries diferentes seguem separados
    await chamar('POST', {}, corpoAcordo([{ nome: 'Sem Ra', serie: '9º ano' }]));
    ({ rows } = await db.query(`SELECT id FROM alunos WHERE LOWER(nome) = 'sem ra'`));
    assert('série diferente → cadastro separado', rows.length === 2);

    const r2 = await chamar('POST', {}, corpoAcordo([{ nome: '   ' }]));
    assert('aluno sem nome → 400', r2._status === 400);
  }

  // ── [4] Paginação ────────────────────────────────────────────────────────
  grupo('[4] Listagem informa o total e navega por páginas');
  {
    await db.query('TRUNCATE acordos CASCADE');
    // criado_em explícito e distinto: inseridos em sequência, os 7 caem no mesmo
    // instante e o empate torna a ordem — e portanto o corte entre páginas —
    // indeterminado. Foi assim que este teste falhou de forma intermitente no
    // pre-push, o que revelou a falta de desempate estável na consulta.
    for (let i = 1; i <= 7; i++) {
      await db.query(
        `INSERT INTO acordos (numero,valor_total_cts,modo_assinatura,criado_por,criado_em)
         VALUES ($1,100000,'fisico',$2, NOW() - ($3 || ' minutes')::interval)`,
        [`2026/${String(i).padStart(3, '0')}`, USER, String(i)]);
    }

    let r = await chamar('GET', { limite: '3', pagina: '1' });
    assert('página 1 → 200', r._status === 200);
    assert('devolve 3 itens',        r._body.acordos.length === 3);
    assert('total conta todos os 7', r._body.total === 7);
    assert('calcula 3 páginas',      r._body.paginas === 3);
    assert('ecoa a página pedida',   r._body.pagina === 1);
    const p1 = r._body.acordos.map(a => a.numero);

    r = await chamar('GET', { limite: '3', pagina: '2' });
    assert('página 2 devolve outros itens',
      r._body.acordos.length === 3 && !r._body.acordos.some(a => p1.includes(a.numero)));

    r = await chamar('GET', { limite: '3', pagina: '3' });
    assert('última página traz a sobra', r._body.acordos.length === 1);

    r = await chamar('GET', { limite: '3', pagina: '99' });
    assert('página além do fim → lista vazia, sem erro',
      r._status === 200 && r._body.acordos.length === 0 && r._body.total === 7);

    r = await chamar('GET', {});
    assert('sem parâmetros → padrão de 50', r._body.limite === 50);

    r = await chamar('GET', { limite: '9999' });
    assert('limite acima do teto é apertado para 200', r._body.limite === 200);

    r = await chamar('GET', { limite: 'abc', pagina: '-5' });
    assert('parâmetros inválidos caem no padrão', r._body.limite === 50 && r._body.pagina === 1);

    r = await chamar('GET', { status: 'quitado' });
    assert('total respeita o filtro', r._body.total === 0);

    // Percorrer todas as páginas tem de devolver cada acordo exatamente uma vez.
    // Sem desempate estável na ORDER BY isto falha quando há empate de data.
    const vistos = [];
    for (let p = 1; p <= 4; p++) {
      const pag = await chamar('GET', { limite: '2', pagina: String(p) });
      vistos.push(...pag._body.acordos.map(a => a.numero));
    }
    assert('varrer as páginas não repete nem perde acordo',
      vistos.length === 7 && new Set(vistos).size === 7);
  }

  await db.close();
  console.log(`\nResultado: ${passou} ✓  ${falhou} ✗`);
  if (falhou > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
