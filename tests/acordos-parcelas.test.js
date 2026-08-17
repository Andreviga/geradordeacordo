// tests/acordos-parcelas.test.js — PUT /api/acordos/:id não pode apagar pagamentos.
//
// Regressão: a versão anterior fazia `DELETE FROM parcelas WHERE acordo_id = $1`
// seguido de INSERT só com numero/vencimento/valor_previsto_cts — perdendo
// valor_pago_cts, data_pagamento, forma_pagamento, registrado_por e os campos de
// estorno. Como nada no sistema escreve em `assinado_em`, a trava de "acordo
// assinado" nunca impediu isso em acordos físicos nem em importações retroativas.
//
// Roda sem banco: _db e _auth são substituídos ANTES de carregar o handler
// (a desestruturação no topo do handler captura as referências no require).

'use strict';

let passou = 0, falhou = 0;
function grupo(t) { console.log(`\n${t}`); }
function assert(desc, cond) {
  if (cond) { passou++; console.log(`  ✓ ${desc}`); }
  else      { falhou++; console.log(`  ✗ ${desc}`); }
}

const ID = '11111111-2222-3333-4444-555555555555';
const TS = '2026-08-10T12:00:00.000Z';

// ── Stubs instalados antes do require do handler ─────────────────────────────
let parcelasPagasForaDaLista = [];
let queriesExecutadas = [];

const clienteFalso = {
  query: async (sql, params) => {
    queriesExecutadas.push({ sql, params });
    if (/FROM acordos WHERE id/.test(sql))
      return { rows: [{ id: ID, assinado_em: null, cancelado: false, atualizado_em: TS }] };
    if (/valor_pago_cts IS NOT NULL/.test(sql))
      return { rows: parcelasPagasForaDaLista.map(n => ({ numero: n })) };
    return { rows: [] };
  },
};

const dbMod = require('../api/_db');
dbMod.withTransaction = async (fn) => fn(clienteFalso);

const authMod = require('../api/_auth');
authMod.verificarRequisicaoComBanco = async () => ({ sub: 'user-1', papel: 'admin', email: 'a@b.c' });
authMod.applyCors = () => {};

const handler = require('../api/acordos/_handler');

function chamar(body) {
  queriesExecutadas = [];
  const resp = {};
  const req = {
    method: 'PUT', url: `/api/acordos/${ID}`,
    query: { params: [ID] }, headers: {}, body,
  };
  const res = {
    setHeader: () => {},
    status: (code) => ({
      json: (d) => { resp.code = code; resp.body = d; return res; },
      end:  ()  => { resp.code = code; return res; },
    }),
  };
  return handler(req, res).then(() => resp);
}

const corpoBase = {
  _versao: TS,
  acordo: { valorTotalCts: 100000 },
  parcelas: [
    { numero: 1, vencimento: '2026-09-10', valorPrevistoCts: 50000 },
    { numero: 2, vencimento: '2026-10-10', valorPrevistoCts: 50000 },
  ],
};

(async () => {
  // ── [1] ───────────────────────────────────────────────────────────────────
  grupo('[1] Edição normal preserva colunas de pagamento (upsert, não DELETE cego)');
  {
    parcelasPagasForaDaLista = [];
    const r = await chamar(corpoBase);
    const sqls = queriesExecutadas.map(q => q.sql);
    const deletes = sqls.filter(s => /DELETE FROM parcelas/.test(s));
    const inserts = sqls.filter(s => /INSERT INTO parcelas/.test(s));

    assert('respondeu 200', r.code === 200);
    assert('não existe DELETE incondicional de parcelas',
      deletes.every(s => /NOT \(numero = ANY/.test(s)));
    assert('DELETE só remove parcelas fora da lista enviada',
      deletes.length === 1 && /NOT \(numero = ANY/.test(deletes[0]));
    assert('INSERT usa ON CONFLICT DO UPDATE',
      inserts.length === 2 && inserts.every(s => /ON CONFLICT \(acordo_id, numero\) DO UPDATE/.test(s)));
    assert('UPDATE do upsert não toca em colunas de pagamento',
      inserts.every(s => !/valor_pago_cts|data_pagamento|registrado_por|estornado/.test(s)));
    const paramsDelete = queriesExecutadas.find(q => /DELETE FROM parcelas/.test(q.sql)).params;
    assert('DELETE recebe os números enviados como array',
      JSON.stringify(paramsDelete[1]) === JSON.stringify([1, 2]));
  }

  // ── [2] ───────────────────────────────────────────────────────────────────
  grupo('[2] Remover parcela COM baixa registrada → 409, transação abortada');
  {
    parcelasPagasForaDaLista = [3];   // parcela 3 foi paga e não está na lista enviada
    const r = await chamar(corpoBase);
    assert('respondeu 409',            r.code === 409);
    assert('code PARCELA_PAGA_REMOVIDA', r.body && r.body.code === 'PARCELA_PAGA_REMOVIDA');
    assert('mensagem cita a parcela',  r.body && /\b3\b/.test(r.body.erro));
    assert('mensagem orienta estornar', r.body && /estorne/i.test(r.body.erro));
    assert('nenhum DELETE foi executado',
      !queriesExecutadas.some(q => /DELETE FROM parcelas/.test(q.sql)));
  }

  // ── [3] ───────────────────────────────────────────────────────────────────
  grupo('[3] Validação de numero antes de qualquer escrita');
  {
    parcelasPagasForaDaLista = [];
    const r = await chamar({ ...corpoBase, parcelas: [{ vencimento: '2026-09-10', valorPrevistoCts: 1 }] });
    assert('respondeu 400',        r.code === 400);
    assert('nenhuma query rodou',  queriesExecutadas.length === 0);

    const r2 = await chamar({ ...corpoBase, parcelas: [{ numero: 0, vencimento: '2026-09-10', valorPrevistoCts: 1 }] });
    assert('numero 0 → 400',       r2.code === 400);
  }

  // ── [4] ───────────────────────────────────────────────────────────────────
  grupo('[4] Travas existentes preservadas');
  {
    parcelasPagasForaDaLista = [];
    const r = await chamar({ ...corpoBase, _versao: undefined, _atualizado_em: undefined });
    assert('sem _versao → 400 VERSAO_AUSENTE', r.code === 400 && r.body.code === 'VERSAO_AUSENTE');

    const r2 = await chamar({ ...corpoBase, _versao: '2020-01-01T00:00:00.000Z' });
    assert('versão desatualizada → 409', r2.code === 409 && r2.body.code === 'VERSAO_DESATUALIZADA');
  }

  console.log(`\nResultado: ${passou} ✓  ${falhou} ✗`);
  if (falhou > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
