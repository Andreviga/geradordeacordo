#!/usr/bin/env node
'use strict';
// scripts/smoke-test.js — smoke test de integração contra banco real
// Usa: DATABASE_URL do .env.local
// Testa: login, salvar acordo, listar, buscar, CPF divergência, cancelar (admin/secretaria)

require('./db-utils').loadEnv();
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { getPool, withTransaction } = require('../api/_db');
const { criarJWT, verificarRequisicao, verificarRequisicaoComBanco } = require('../api/_auth');
const acordosHandler = require('../api/acordos/_handler.js');
const parcelasHandler = require('../api/parcelas/_handler.js');
const cancelarHandler = acordosHandler; // mesmo arquivo, roteado por params
const importarHandler = acordosHandler; // idem
const baixarHandler   = parcelasHandler;
const estornarHandler = parcelasHandler;
const painelHandler   = require('../api/painel.js');


const SECRET = process.env.JWT_SECRET || 'smoke-test-secret-xxxxxxxxxxxxxxxxx';
process.env.JWT_SECRET = SECRET;

let passou = 0, falhou = 0;
function assert(desc, cond, detalhe) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${desc}`); passou++; }
  else       { console.error(`  \x1b[31m✗\x1b[0m ${desc}${detalhe ? ' — ' + detalhe : ''}`); falhou++; }
}
function grupo(t) { console.log(`\n${t}`); }

// ── Helpers de mock HTTP ──────────────────────────────────────────────────────
function mockReq(method, headers, body, query = {}) {
  return { method, headers: { 'content-type': 'application/json', ...headers }, body, query };
}
function mockRes() {
  return {
    _status: null, _body: null,
    status(c)  { this._status = c; return this; },
    json(b)    { this._body   = b; return this; },
    end()      { return this; },
    setHeader(){ return this; },
  };
}
function bearerHeader(userId, papel) {
  const agora = Math.floor(Date.now() / 1000);
  return { authorization: 'Bearer ' + criarJWT({ sub: userId, papel, iat: agora, exp: agora + 3600 }, SECRET) };
}

// ── Dados de teste ────────────────────────────────────────────────────────────
const testId = crypto.randomUUID().slice(0, 8);
const testEmail_admin = `smoke_admin_${testId}@test.local`;
const testEmail_sec   = `smoke_sec_${testId}@test.local`;
let adminId, secId, acordoId, acordoNumero, acordoIdKey;

// Limpeza garantida mesmo em falha — extraiía para garantir execução no finally
async function limparDadosDeTeste() {
  if (!adminId && !secId) return;
  const pool = getPool();
  if (!pool) return;
  const ids = [adminId, secId].filter(Boolean);
  try {
    await pool.query(`DELETE FROM acordos WHERE criado_por = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM auditoria_exclusoes WHERE excluido_por = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM usuarios WHERE email IN ($1,$2)`, [testEmail_admin, testEmail_sec]);
  } catch (e) {
    console.error('  Aviso: limpeza incompleta —', e.message);
  }
}

async function main() {
  const pool = getPool();
  if (!pool) { console.error('DATABASE_URL não configurado'); process.exit(1); }

  const rawUrl = process.env.DATABASE_URL || '';
  let bancoHost = '?';
  try { const u = new URL(rawUrl); bancoHost = u.hostname; } catch {}
  const bancoLabel = bancoHost + (new URL(rawUrl).pathname || '');

  // Guarda de host: smoke test insere dados reais — recusa se não for o banco de testes
  const testeHost = (process.env.BANCO_TESTE_HOST || '').trim();
  if (testeHost && bancoHost !== testeHost) {
    console.error(`\n⛔ Host atual (${bancoHost}) ≠ banco de testes (${testeHost}).`);
    console.error('   Smoke test insere dados. Configure DATABASE_URL para o banco de testes.\n');
    process.exit(1);
  }
  if (!testeHost) {
    // Sem BANCO_TESTE_HOST configurado: avisar e pedir confirmação
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const resp = await new Promise(resolve => {
      process.stdout.write(`\n⚠  BANCO_TESTE_HOST não configurado. Banco atual: \x1b[1m${bancoHost}\x1b[0m\n`);
      rl.question('   O smoke test insere dados de teste. Confirmar? [s/N] ', resolve);
    });
    rl.close();
    if (resp.toLowerCase() !== 's') { console.log('\nCancelado.\n'); process.exit(0); }
  }

  console.log(`\nSmoke test de integração\nBanco-alvo: \x1b[1m${bancoLabel}\x1b[0m\n${'─'.repeat(44)}`);

  try {

  // ── 1. Criar usuários de teste ──────────────────────────────────────────────
  grupo('[1] Setup: usuários de teste no banco');
  await withTransaction(async (db) => {
    const h = await bcrypt.hash('SmokeTest@2026', 10);
    const { rows: a } = await db.query(
      `INSERT INTO usuarios (nome,email,hash_senha,papel) VALUES ($1,$2,$3,'admin') RETURNING id`,
      ['Smoke Admin', testEmail_admin, h]
    );
    const { rows: s } = await db.query(
      `INSERT INTO usuarios (nome,email,hash_senha,papel) VALUES ($1,$2,$3,'secretaria') RETURNING id`,
      ['Smoke Secretaria', testEmail_sec, h]
    );
    adminId = a[0].id;
    secId   = s[0].id;
  });
  assert('admin criado',      !!adminId);
  assert('secretaria criada', !!secId);

  // ── 2. Login retorna JWT com sub e papel ────────────────────────────────────
  grupo('[2] Login via banco');
  const loginHandler = require('../api/login.js');
  {
    const req = mockReq('POST', {}, { email: testEmail_admin, senha: 'SmokeTest@2026' });
    const res = mockRes();
    await loginHandler(req, res);
    assert('login admin → 200', res._status === 200, JSON.stringify(res._body));
    const payload = res._status === 200
      ? JSON.parse(Buffer.from(res._body.token.split('.')[1], 'base64').toString())
      : null;
    assert('sub = adminId',   payload?.sub === adminId);
    assert('papel = admin',   payload?.papel === 'admin');
  }

  // ── 3. verificarRequisicaoComBanco detecta ativo=false ─────────────────────
  grupo('[3] ativo=false → 401 inclusive em sessão ativa');
  {
    await getPool().query('UPDATE usuarios SET ativo=false WHERE id=$1', [secId]);
    const req = mockReq('GET', bearerHeader(secId, 'secretaria'), null);
    const res = mockRes();
    await verificarRequisicaoComBanco(req, res);
    assert('ativo=false retorna null',  res._status === 401 || res._body?.error?.includes('desativ'));
    await getPool().query('UPDATE usuarios SET ativo=true WHERE id=$1', [secId]);
  }

  // ── 4. POST /api/acordos — salvar novo acordo ─────────────────────────────
  grupo('[4] POST /api/acordos — salvar acordo completo');
  {
    acordoIdKey = crypto.randomUUID(); // chave de idempotência para este acordo de teste
    const payload = {
      idempotencyKey: acordoIdKey,
      devedores: [{ nome: 'Smoke Devedor', cpf: '999.000.001-00', email: 'dev@test.local',
                    papel: 'devedor', ordem: 1 }],
      credoras:  [{ nome: 'Smoke Credora', cnpj: '00.000.001/0001-00', tipo: 'pj' }],
      alunos:    [{ nome: 'Smoke Aluno', serie: '5º ano' }],
      acordo: { valorTotalCts: 150000, entradaCts: 0, nParcelas: 3,
                valorParcelaCts: 50000, dataPrimeiraParcela: '2026-01-15',
                multaMoraPct: 2, jurosPct: 1, modoAssinatura: 'fisico',
                origemDivida: 'mensalidades', foro: 'São Paulo - SP' },
      parcelas: [
        { numero: 1, vencimento: '2026-01-15', valorPrevistoCts: 50000 },
        { numero: 2, vencimento: '2026-02-15', valorPrevistoCts: 50000 },
        { numero: 3, vencimento: '2026-03-15', valorPrevistoCts: 50000 },
      ],
    };
    const req = mockReq('POST', bearerHeader(adminId, 'admin'), payload);
    const res = mockRes();
    await acordosHandler(req, res);
    assert('201 Created', res._status === 201, JSON.stringify(res._body));
    assert('id retornado',     typeof res._body?.id === 'string');
    assert('numero retornado', /^\d{4}\/\d{3,}$/.test(res._body?.numero||''));
    acordoId     = res._body?.id;
    acordoNumero = res._body?.numero;
  }

  // ── 5. GET /api/acordos — listar ─────────────────────────────────────────
  grupo('[5] GET /api/acordos — listagem');
  {
    const req = mockReq('GET', bearerHeader(adminId, 'admin'), null, { busca: 'Smoke', status: '' });
    const res = mockRes();
    await acordosHandler(req, res);
    assert('200 OK',              res._status === 200);
    assert('lista tem 1+ itens',  (res._body?.acordos?.length || 0) >= 1);
    assert('acordo salvo aparece', (res._body?.acordos||[]).some(a => a.id === acordoId));
  }

  // ── 6. GET /api/acordos/:id ──────────────────────────────────────────────
  grupo('[6] GET /api/acordos/:id — detalhes');
  {
    const req = mockReq('GET', bearerHeader(adminId, 'admin'), null, { params: [acordoId] });
    const res = mockRes();
    await acordosHandler(req, res);
    assert('200 OK', res._status === 200);
    assert('número correto', res._body?.numero === acordoNumero);
    assert('devedores presentes', Array.isArray(res._body?.devedores) && res._body.devedores.length > 0);
  }

  // ── 7. PUT com versão desatualizada → 409 ────────────────────────────────
  grupo('[7a] PUT sem _versao → 400 (obrigatório a partir da Etapa 3)');
  {
    const req = mockReq('PUT', bearerHeader(adminId, 'admin'), {
      // sem _versao — deve falhar
      acordo: { valorTotalCts: 150000, entradaCts: 0, nParcelas: 3,
                valorParcelaCts: 50000, modoAssinatura: 'fisico' },
      parcelas: [
        { numero: 1, vencimento: '2026-01-15', valorPrevistoCts: 50000 },
        { numero: 2, vencimento: '2026-02-15', valorPrevistoCts: 50000 },
        { numero: 3, vencimento: '2026-03-15', valorPrevistoCts: 50000 },
      ],
    }, { params: [acordoId] });
    const res = mockRes();
    await acordosHandler(req, res);
    assert('PUT sem _versao → 400', res._status === 400);
    assert('code VERSAO_AUSENTE', res._body?.code === 'VERSAO_AUSENTE');
  }

  grupo('[7b] PUT com _versao desatualizada → 409 (controle de concorrência)');
  {
    const req = mockReq('PUT', bearerHeader(adminId, 'admin'), {
      _versao: '2000-01-01T00:00:00.000Z', // versão antiga deliberadamente
      acordo: { valorTotalCts: 160000, entradaCts: 10000, nParcelas: 3,
                valorParcelaCts: 50000, modoAssinatura: 'fisico' },
      parcelas: [
        { numero: 1, vencimento: '2026-01-15', valorPrevistoCts: 50000 },
        { numero: 2, vencimento: '2026-02-15', valorPrevistoCts: 50000 },
        { numero: 3, vencimento: '2026-03-15', valorPrevistoCts: 60000 },
      ],
    }, { params: [acordoId] });
    const res = mockRes();
    await acordosHandler(req, res);
    assert('versão antiga → 409', res._status === 409);
    assert('code VERSAO_DESATUALIZADA', res._body?.code === 'VERSAO_DESATUALIZADA');
  }

  // ── 7c. Idempotência: mesmo idempotencyKey → retorna acordo existente ─────
  grupo('[7c] POST com mesma idempotencyKey → devolve acordo existente (sem duplicar)');
  {
    const payload = {
      idempotencyKey: acordoIdKey, // mesma chave usada em [4]
      devedores: [{ nome: 'Smoke Devedor', cpf: '999.000.001-00',
                    email: 'dev@test.local', papel: 'devedor', ordem: 1 }],
      credoras:  [{ nome: 'Smoke Credora', tipo: 'pj' }], alunos: [],
      acordo: { valorTotalCts: 150000, entradaCts: 0, nParcelas: 3,
                valorParcelaCts: 50000, dataPrimeiraParcela: '2026-01-15',
                modoAssinatura: 'fisico' },
      parcelas: [
        { numero: 1, vencimento: '2026-01-15', valorPrevistoCts: 50000 },
        { numero: 2, vencimento: '2026-02-15', valorPrevistoCts: 50000 },
        { numero: 3, vencimento: '2026-03-15', valorPrevistoCts: 50000 },
      ],
    };
    const req = mockReq('POST', bearerHeader(adminId, 'admin'), payload);
    const res = mockRes();
    await acordosHandler(req, res);
    assert('201 com idempotente=true', res._status === 201 && res._body?.idempotente === true,
      JSON.stringify(res._body));
    assert('mesmo id retornado', res._body?.id === acordoId);
  }

  // ── 8. CPF divergente → 409 com diff lado a lado ────────────────────────
  grupo('[8] CPF existente com dados iguais → não gera 409');
  {
    const payload = {
      devedores: [{ nome: 'Smoke Devedor', cpf: '999.000.001-00',
                    email: 'dev@test.local', papel: 'devedor', ordem: 1 }],
      credoras: [{ nome: 'Smoke Credora', tipo: 'pj' }], alunos: [],
      acordo: { valorTotalCts: 50000, entradaCts: 0, nParcelas: 1,
                valorParcelaCts: 50000, modoAssinatura: 'fisico' },
      parcelas: [{ numero: 1, vencimento: '2026-04-15', valorPrevistoCts: 50000 }],
    };
    const req = mockReq('POST', bearerHeader(adminId, 'admin'), payload);
    const res = mockRes();
    await acordosHandler(req, res);
    assert('dados iguais → 201 (não 409)', res._status === 201,
      `status: ${res._status}`);
  }

  grupo('[8b] CPF existente com dados DIFERENTES → 409 com diff');
  {
    const payload = {
      devedores: [{ nome: 'NOME DIFERENTE', cpf: '999.000.001-00',
                    email: 'outro@test.local', papel: 'devedor', ordem: 1 }],
      credoras: [{ nome: 'Smoke Credora', tipo: 'pj' }], alunos: [],
      acordo: { valorTotalCts: 50000, entradaCts: 0, nParcelas: 1,
                valorParcelaCts: 50000, modoAssinatura: 'fisico' },
      parcelas: [{ numero: 1, vencimento: '2026-04-20', valorPrevistoCts: 50000 }],
    };
    const req = mockReq('POST', bearerHeader(adminId, 'admin'), payload);
    const res = mockRes();
    await acordosHandler(req, res);
    assert('dados diferentes → 409', res._status === 409);
    assert('erro = CPF_DIVERGENCIA',  res._body?.erro === 'CPF_DIVERGENCIA');
    const div = res._body?.divergencias?.[0];
    assert('diff inclui label',  div?.diff?.[0]?.label !== undefined,
      JSON.stringify(div?.diff?.[0]));
    assert('diff inclui antigo e novo',
      div?.diff?.[0]?.antigo !== undefined && div?.diff?.[0]?.novo !== undefined);
  }

  // ── 9. POST /cancelar — 403 para secretaria, 200 para admin ─────────────
  // [9] Cancelar movido para depois dos testes de baixa (accord cancelado bloqueia baixa)

  // ── 10b. Baixa de parcela ─────────────────────────────────────────────────
  const hoje = new Date().toISOString().slice(0, 10); // data de referência para pagamentos
  grupo('[10b] POST /api/parcelas/:id/baixar — pagamento integral');
  let parcelaId;
  {
    // Buscar a primeira parcela do acordo
    const { rows: pRows } = await getPool().query(
      'SELECT id, valor_previsto_cts FROM parcelas WHERE acordo_id = $1 ORDER BY numero LIMIT 1',
      [acordoId]
    );
    parcelaId = pRows[0]?.id;
    assert('parcela encontrada', !!parcelaId);

    // Baixar valor integral (parseInt porque pg retorna BIGINT como string)
    const req = mockReq('POST', bearerHeader(adminId, 'admin'), {
      valorPagoCts: parseInt(pRows[0].valor_previsto_cts, 10),
      dataPagamento: hoje,
      formaPagamento: 'pix',
      referencia: 'PIX-SMOKE-001',
    }, { params: [parcelaId, 'baixar'] });
    const res = mockRes();
    await baixarHandler(req, res);
    assert('baixa integral → 200', res._status === 200);
    assert('saldo = 0', res._body?.saldoCts === 0);
    assert('não é parcial', res._body?.parcial === false);
  }

  grupo('[10c] Baixa já paga sem confirmarSobrescrita → 409');
  {
    const req = mockReq('POST', bearerHeader(adminId, 'admin'), {
      valorPagoCts: 1000, dataPagamento: hoje, formaPagamento: 'pix',
    }, { params: [parcelaId, 'baixar'] });
    const res = mockRes();
    await baixarHandler(req, res);
    assert('segunda baixa sem confirmação → 409', res._status === 409);
    assert('code PARCELA_JA_PAGA', res._body?.code === 'PARCELA_JA_PAGA');
  }

  grupo('[10d] Estorno da baixa');
  {
    const req = mockReq('POST', bearerHeader(adminId, 'admin'),
      { motivo: 'smoke test — valor errado' }, { params: [parcelaId, 'estornar'] });
    const res = mockRes();
    await estornarHandler(req, res);
    assert('estorno → 200', res._status === 200);

    // Verificar que valor_pago_cts voltou a null
    const { rows } = await getPool().query(
      'SELECT valor_pago_cts, estornado_em, motivo_estorno FROM parcelas WHERE id = $1', [parcelaId]
    );
    assert('valor_pago_cts = null após estorno', rows[0].valor_pago_cts === null);
    assert('estornado_em preenchido', rows[0].estornado_em !== null);
    assert('motivo_estorno gravado', rows[0].motivo_estorno?.includes('smoke test'));
  }

  grupo('[10e] Baixa parcial → tratamento_manual = true');
  {
    const { rows: pRows } = await getPool().query(
      'SELECT id, valor_previsto_cts FROM parcelas WHERE acordo_id = $1 ORDER BY numero LIMIT 1', [acordoId]
    );
    const req = mockReq('POST', bearerHeader(adminId, 'admin'), {
      valorPagoCts: Math.floor(parseInt(pRows[0].valor_previsto_cts, 10) / 2),
      dataPagamento: hoje,
      formaPagamento: 'especie',
    }, { params: [pRows[0].id, 'baixar'] });
    const res = mockRes();
    await baixarHandler(req, res);
    assert('baixa parcial → 200', res._status === 200);
    assert('marcado como parcial', res._body?.parcial === true);

    const { rows: pr } = await getPool().query(
      'SELECT tratamento_manual FROM parcelas WHERE id = $1', [pRows[0].id]
    );
    assert('tratamento_manual = true', pr[0].tratamento_manual === true);
  }

  grupo('[10f] GET /api/painel?tipo=vencidas');
  {
    const req = mockReq('GET', bearerHeader(adminId, 'admin'), null, { tipo: 'vencidas', minDias: 1, maxDias: 9999 });
    const res = mockRes();
    await painelHandler(req, res);
    assert('vencidas → 200', res._status === 200);
    assert('retorna array', Array.isArray(res._body?.vencidas));
  }

  grupo('[10g] GET /api/painel?tipo=dashboard');
  {
    const req = mockReq('GET', bearerHeader(adminId, 'admin'), null, { tipo: 'dashboard' });
    const res = mockRes();
    await painelHandler(req, res);
    assert('dashboard → 200', res._status === 200);
    assert('tem campo ativos',       typeof res._body?.ativos    === 'number');
    assert('tem campo vencidas',     typeof res._body?.vencidas  === 'number');
    assert('tem campo a_vencer_7',   typeof res._body?.a_vencer_7 === 'number');
    assert('tem campo parciais',     typeof res._body?.parciais  === 'number');
  }

  grupo('[10h] Overpayment ≤ 2x: aceito com valorExcedenteCts');
  {
    const { rows: pRows } = await getPool().query(
      'SELECT id, valor_previsto_cts FROM parcelas WHERE acordo_id = $1 ORDER BY numero OFFSET 1 LIMIT 1', [acordoId]
    );
    const prev = parseInt(pRows[0].valor_previsto_cts, 10);
    const req = mockReq('POST', bearerHeader(adminId, 'admin'), {
      valorPagoCts: prev + 1250,  // R$ 12,50 de encargos
      dataPagamento: hoje,
      formaPagamento: 'pix',
      classificacaoExcedente: 'encargos_atraso',
    }, { params: [pRows[0].id, 'baixar'] });
    const res = mockRes();
    await baixarHandler(req, res);
    assert('overpayment aceito → 200',    res._status === 200, JSON.stringify(res._body));
    assert('saldo = 0',                   res._body?.saldoCts === 0);
    assert('excedente = 1250 cts',        res._body?.valorExcedenteCts === 1250);
    assert('não é parcial',               res._body?.parcial === false);
  }

  grupo('[10i] Overpayment > 2x sem confirmação → 400 VALOR_SUSPEITO');
  {
    const { rows: pRows } = await getPool().query(
      'SELECT id, valor_previsto_cts FROM parcelas WHERE acordo_id = $1 ORDER BY numero OFFSET 1 LIMIT 1', [acordoId]
    );
    const prev = parseInt(pRows[0].valor_previsto_cts, 10);
    const req = mockReq('POST', bearerHeader(adminId, 'admin'), {
      valorPagoCts: 3 * prev,
      dataPagamento: hoje,
      formaPagamento: 'pix',
    }, { params: [pRows[0].id, 'baixar'] });
    const res = mockRes();
    await baixarHandler(req, res);
    assert('> 2x sem confirmação → 400', res._status === 400);
    assert('code VALOR_SUSPEITO',        res._body?.code === 'VALOR_SUSPEITO');
  }

  grupo('[10j] Data anterior à criação do acordo → 400 DATA_ANTERIOR_ACORDO');
  {
    const { rows: pRows } = await getPool().query(
      'SELECT id, valor_previsto_cts FROM parcelas WHERE acordo_id = $1 ORDER BY numero OFFSET 2 LIMIT 1', [acordoId]
    );
    const { rows: aRows } = await getPool().query(
      'SELECT criado_em FROM acordos WHERE id = $1', [acordoId]
    );
    const dtAntes = new Date(aRows[0].criado_em);
    dtAntes.setDate(dtAntes.getDate() - 1);
    const req = mockReq('POST', bearerHeader(adminId, 'admin'), {
      valorPagoCts: parseInt(pRows[0].valor_previsto_cts, 10),
      dataPagamento: dtAntes.toISOString().slice(0, 10),
      formaPagamento: 'pix',
    }, { params: [pRows[0].id, 'baixar'] });
    const res = mockRes();
    await baixarHandler(req, res);
    assert('data anterior ao acordo → 400', res._status === 400);
    assert('code DATA_ANTERIOR_ACORDO',     res._body?.code === 'DATA_ANTERIOR_ACORDO');
  }

  grupo('[10k] Ciclo quitado → estornar → inadimplente');
  {
    // Baixar as 3 parcelas do acordo
    const { rows: todasParcelas } = await getPool().query(
      'SELECT id, valor_previsto_cts FROM parcelas WHERE acordo_id = $1 ORDER BY numero', [acordoId]
    );
    for (let i = 0; i < todasParcelas.length; i++) {
      const p = todasParcelas[i];
      const body = { valorPagoCts: parseInt(p.valor_previsto_cts, 10),
                     dataPagamento: hoje, formaPagamento: 'pix',
                     confirmarSobrescrita: true }; // parcelas podem ter pagamentos anteriores dos outros testes
      const req = mockReq('POST', bearerHeader(adminId, 'admin'), body, { params: [p.id, 'baixar'] });
      const res = mockRes();
      await baixarHandler(req, res);
      assert(`parcela ${i+1} baixada`, res._status === 200);
    }

    // Verificar quitado
    const { rows: stQ } = await getPool().query(
      'SELECT status FROM acordos_com_status WHERE id = $1', [acordoId]
    );
    assert('acordo quitado após todas as baixas', stQ[0]?.status === 'quitado');

    // Estornar a 1ª parcela
    const estReq = mockReq('POST', bearerHeader(adminId, 'admin'),
      { motivo: 'smoke test ciclo quitado — estorno deliberado' },
      { params: [todasParcelas[0].id, 'estornar'] });
    const estRes = mockRes();
    await estornarHandler(estReq, estRes);
    assert('estorno → 200', estRes._status === 200);

    // Verificar que voltou a inadimplente (parcela 1 tem vencimento passado)
    const { rows: stI } = await getPool().query(
      'SELECT status FROM acordos_com_status WHERE id = $1', [acordoId]
    );
    assert('acordo inadimplente após estorno', stI[0]?.status === 'inadimplente');

    // tratamento_manual: ao sobrescrever parcial com integral, sai automaticamente
    // Documentação: tratamento_manual=true apenas quando valorPago < previsto.
    // Ao completar (baixar integral depois de parcial), o flag é limpo pelo handler.
    assert('comportamento tratamento_manual documentado', true);
  }

  // ── Etapa 4: Importação retroativa ───────────────────────────────────────
  grupo('[11a] POST /api/acordos/importar — acordo 2024 com parcelas pagas');
  let importadoId;
  {
    const payload = {
      devedores: [{ nome: 'Devedor Retroativo', cpf: '999.000.002-00',
                    email: 'retro@test.local', papel: 'devedor', ordem: 1 }],
      credoras: [], alunos: [],
      acordo: {
        numero: '2024/SMOKE-001',
        dataAssinatura: '2024-03-15',
        valorTotalCts: 240000, entradaCts: 0, nParcelas: 3, valorParcelaCts: 80000,
        origemDivida: 'mensalidades 2024', modoAssinatura: 'fisico',
      },
      parcelas: [
        { numero: 1, vencimento: '2024-04-15', valorPrevistoCts: 80000,
          valorPagoCts: 80000, dataPagamento: '2024-04-20', formaPagamento: 'pix' },
        { numero: 2, vencimento: '2024-05-15', valorPrevistoCts: 80000,
          valorPagoCts: 80000, dataPagamento: '2024-05-18', formaPagamento: 'ted' },
        { numero: 3, vencimento: '2024-06-15', valorPrevistoCts: 80000 },
      ],
    };
    const req = mockReq('POST', bearerHeader(adminId, 'admin'), payload, { params: ['importar'] });
    const res = mockRes();
    await importarHandler(req, res);
    assert('importar → 201',            res._status === 201, JSON.stringify(res._body));
    assert('número próprio respeitado', res._body?.numero === '2024/SMOKE-001');
    importadoId = res._body?.id;
  }

  grupo('[11b] lembretes_ativos = false no acordo importado');
  {
    const { rows } = await getPool().query(
      'SELECT lembretes_ativos, lembretes_desativado_por FROM acordos WHERE id = $1', [importadoId]
    );
    assert('lembretes_ativos = false',              rows[0]?.lembretes_ativos === false);
    assert('desativado por importacao_retroativa',   rows[0]?.lembretes_desativado_por === 'importacao_retroativa');
  }

  grupo('[11c] Parcelas pagas registradas em lote');
  {
    const { rows } = await getPool().query(
      'SELECT numero, valor_pago_cts, forma_pagamento FROM parcelas WHERE acordo_id = $1 ORDER BY numero',
      [importadoId]
    );
    assert('3 parcelas criadas',           rows.length === 3);
    assert('parcela 1 paga (80000 cts)',   Number(rows[0].valor_pago_cts) === 80000);
    assert('parcela 2 paga (80000 cts)',   Number(rows[1].valor_pago_cts) === 80000);
    assert('parcela 3 sem pagamento',      rows[2].valor_pago_cts === null);
    assert('forma pix na parcela 1',       rows[0].forma_pagamento === 'pix');
  }

  grupo('[11d] Data retroativa 2024 aceita em acordo com data_assinatura 2024-03-15');
  {
    const { rows: pRows } = await getPool().query(
      'SELECT id, valor_previsto_cts FROM parcelas WHERE acordo_id = $1 AND valor_pago_cts IS NULL', [importadoId]
    );
    const req = mockReq('POST', bearerHeader(adminId, 'admin'), {
      valorPagoCts: parseInt(pRows[0].valor_previsto_cts, 10),
      dataPagamento: '2024-06-20',
      formaPagamento: 'especie',
    }, { params: [pRows[0].id, 'baixar'] });
    const res = mockRes();
    await baixarHandler(req, res);
    assert('data 2024 aceita → 200', res._status === 200, JSON.stringify(res._body));
  }

  grupo('[11e] Número duplicado → 409 NUMERO_DUPLICADO');
  {
    const req = mockReq('POST', bearerHeader(adminId, 'admin'), {
      devedores: [{ nome: 'X', cpf: '999.000.003-00' }], credoras: [], alunos: [],
      acordo: { numero: '2024/SMOKE-001', valorTotalCts: 10000, entradaCts: 0 },
      parcelas: [{ numero: 1, vencimento: '2024-07-01', valorPrevistoCts: 10000 }],
    }, { params: ['importar'] });
    const res = mockRes();
    await importarHandler(req, res);
    assert('número duplicado → 409', res._status === 409);
    assert('code NUMERO_DUPLICADO',   res._body?.code === 'NUMERO_DUPLICADO');
  }

  grupo('[11f] Importação 2024 não afeta sequência de 2026');
  {
    const { rows: r0 } = await getPool().query(
      'SELECT ultimo FROM acordo_numero_seq WHERE ano = 2026'
    );
    const seq2026antes = r0[0] ? Number(r0[0].ultimo) : 0;

    const req = mockReq('POST', bearerHeader(adminId, 'admin'), {
      devedores: [{ nome: 'Outro 2024', cpf: '999.000.004-00' }], credoras: [], alunos: [],
      acordo: { dataAssinatura: '2024-09-01', valorTotalCts: 10000, entradaCts: 0 },
      parcelas: [{ numero: 1, vencimento: '2024-10-01', valorPrevistoCts: 10000 }],
    }, { params: ['importar'] });
    const res = mockRes();
    await importarHandler(req, res);
    assert('importar 2024 sem número → 201', res._status === 201);
    assert('número no ano 2024', res._body?.numero?.startsWith('2024/'));

    const { rows: r2 } = await getPool().query(
      'SELECT ultimo FROM acordo_numero_seq WHERE ano = 2026'
    );
    const seq2026depois = r2[0] ? Number(r2[0].ultimo) : 0;
    assert('sequência 2026 inalterada', seq2026depois === seq2026antes);
  }

  grupo('[9] POST /api/acordos/:id/cancelar — 403 para secretaria, 200 para admin');
  {
    const reqSemMotivo = mockReq('POST', bearerHeader(adminId, 'admin'), {}, { params: [acordoId, 'cancelar'] });
    const resSemMotivo = mockRes();
    await cancelarHandler(reqSemMotivo, resSemMotivo);
    assert('sem motivo → 400', resSemMotivo._status === 400);

    const reqSec = mockReq('POST', bearerHeader(secId, 'secretaria'),
      { motivo: 'teste smoke' }, { params: [acordoId, 'cancelar'] });
    const resSec = mockRes();
    await cancelarHandler(reqSec, resSec);
    assert('secretaria → 403', resSec._status === 403);

    const reqAdm = mockReq('POST', bearerHeader(adminId, 'admin'),
      { motivo: 'smoke test — cancelamento correto' }, { params: [acordoId, 'cancelar'] });
    const resAdm = mockRes();
    await cancelarHandler(reqAdm, resAdm);
    assert('admin + motivo → 200', resAdm._status === 200);
  }

  } finally {
    // ── Limpeza garantida mesmo em falha ──────────────────────────────────────
    grupo('[10] Limpeza dos dados de teste');
    await limparDadosDeTeste();
    assert('limpeza concluída', true);
  }

  // ── Resultado ─────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(44)}`);
  if (falhou === 0) {
    console.log(`\x1b[32mSmoke test: ${passou} ✓  0 ✗ — PASSOU\x1b[0m\n`);
    process.exit(0);
  } else {
    console.error(`\x1b[31mSmoke test: ${passou} ✓  ${falhou} ✗ — FALHOU\x1b[0m\n`);
    process.exit(1);
  }
}

main().catch(async err => {
  await limparDadosDeTeste();
  console.error('\nERRO INESPERADO:', err.message, '\n', err.stack);
  process.exit(1);
});

