// tests/restore.test.js — testes do scripts/db-restore.js
//
// Não precisa de banco: o client é dublado e registra o SQL emitido.
// O teste de integração contra Postgres real vive em scripts/test-restore-integrado.js.

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const zlib = require('zlib');

const { lerDump, inserirTabela, chunk } = require('../scripts/db-restore');

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else      { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

function tmp(nome, buf) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-')), nome);
  fs.writeFileSync(p, buf);
  return p;
}

// Client dublado: guarda os comandos para inspeção
function clientFake() {
  const sql = [];
  return {
    sql,
    async query(texto, params) {
      sql.push({ texto, params: params || [] });
      if (/^SELECT COUNT/i.test(texto)) return { rows: [{ n: 0 }] };
      return { rows: [] };
    },
  };
}

const DUMP_OK = {
  _meta: { gerado_em: '2026-08-01T06:00:00.000Z', tabelas: ['usuarios'] },
  dados: { usuarios: [{ id: 'u1', nome: 'Ana' }, { id: 'u2', nome: 'Bruno' }] },
};

// ── [1] Leitura: gzip detectado pelos bytes mágicos, não pela extensão ────────
grupo('[1] lerDump aceita gzip e JSON puro');
{
  const gz = tmp('backup.json.gz', zlib.gzipSync(Buffer.from(JSON.stringify(DUMP_OK))));
  const r1 = lerDump(gz);
  assert('gzip: descomprime e parseia', r1.dump.dados.usuarios.length === 2);
  assert('gzip: sinalizado como gzip',  r1.ehGzip === true);

  const puro = tmp('backup.json', Buffer.from(JSON.stringify(DUMP_OK)));
  const r2 = lerDump(puro);
  assert('json puro: parseia',          r2.dump.dados.usuarios.length === 2);
  assert('json puro: não é gzip',       r2.ehGzip === false);

  // Extensão mentindo sobre o conteúdo: o que vale são os bytes
  const mentiroso = tmp('mentiroso.json', zlib.gzipSync(Buffer.from(JSON.stringify(DUMP_OK))));
  const r3 = lerDump(mentiroso);
  assert('extensão .json mas conteúdo gzip: lê certo', r3.dump.dados.usuarios.length === 2);
}

// ── [2] Lotes respeitam o teto de parâmetros do Postgres ─────────────────────
grupo('[2] chunk fatia conforme o limite de parâmetros');
{
  assert('120 linhas em lotes de 50 → 3 lotes', chunk(new Array(120).fill(0), 50).length === 3);
  assert('lote exato não gera sobra',            chunk(new Array(100).fill(0), 50).length === 2);
  assert('lista vazia → nenhum lote',            chunk([], 50).length === 0);
}

// ── [3] INSERT em lote: um comando por lote, parâmetros na ordem ─────────────
grupo('[3] inserirTabela agrupa em lote e nunca passa de 65535 parâmetros');
{
  (async () => {
    const c = clientFake();
    const n = await inserirTabela(c, 'usuarios', DUMP_OK.dados.usuarios);
    assert('devolve o total gravado', n === 2);
    assert('um único INSERT para 2 linhas', c.sql.length === 1);
    assert('nomes de coluna entre aspas', /INSERT INTO "usuarios" \("id","nome"\)/.test(c.sql[0].texto));
    assert('duas tuplas de valores', /VALUES \(\$1,\$2\),\(\$3,\$4\)$/.test(c.sql[0].texto));
    assert('parâmetros na ordem', JSON.stringify(c.sql[0].params) === '["u1","Ana","u2","Bruno"]');

    // 30 colunas → teto de 2000 linhas por lote (60000/30)
    const largas = new Array(4100).fill(0).map((_, i) => {
      const o = {};
      for (let k = 0; k < 30; k++) o['c' + k] = i;
      return o;
    });
    const c2 = clientFake();
    await inserirTabela(c2, 'parcelas', largas);
    assert('4100 linhas x 30 colunas → 3 lotes', c2.sql.length === 3);
    const maior = Math.max(...c2.sql.map(s => s.params.length));
    assert(`nenhum comando passa de 65535 parâmetros (maior: ${maior})`, maior <= 65535);

    // Coluna ausente na linha vira NULL, não "undefined"
    const c3 = clientFake();
    await inserirTabela(c3, 'usuarios', [{ id: 'x', nome: 'Ana' }, { id: 'y' }]);
    assert('campo ausente vira NULL', c3.sql[0].params[3] === null);

    // Tabela vazia não emite comando
    const c4 = clientFake();
    const zero = await inserirTabela(c4, 'usuarios', []);
    assert('tabela vazia: nenhum INSERT', zero === 0 && c4.sql.length === 0);

    fim();
  })();
}

function fim() {
  console.log(`\nResultado: ${passou} ✓  ${falhou} ✗`);
  if (falhou > 0) process.exit(1);
}
