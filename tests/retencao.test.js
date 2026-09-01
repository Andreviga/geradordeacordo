// tests/retencao.test.js — expurgo LGPD contra PostgreSQL real (PGlite).
//
// O que precisa estar certo aqui é o que o motor NÃO apaga. Um falso positivo
// destrói dado pessoal de alguém com acordo em aberto, e não tem volta.

'use strict';

const fs   = require('fs');
const path = require('path');

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else      { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = U(1);

// Datas relativas a hoje, para o teste não envelhecer
function anosAtras(n) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  await db.waitReady;
  await db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));

  const { executarRetencao, mascararCpf } = require('../api/cron/_retencao_engine');

  await db.query(`INSERT INTO usuarios (id,nome,email,hash_senha,papel,ativo)
                  VALUES ($1,'Admin','a@x.com','$2a$10$h','admin',true)`, [ADMIN]);

  // Monta um acordo com um devedor e um aluno, com as parcelas já no estado pedido
  let seq = 10;
  async function cenario({ devedor, aluno, pago, vencimento, cancelado = false, cpf }) {
    const idDev = U(seq++), idAlu = U(seq++), idAco = U(seq++), idPar = U(seq++);
    await db.query(`INSERT INTO devedores (id,nome,cpf,email,telefone,end_logradouro)
                    VALUES ($1,$2,$3,'x@y.com','(11)99999-9999','Rua Um, 1')`, [idDev, devedor, cpf]);
    await db.query(`INSERT INTO alunos (id,nome,serie) VALUES ($1,$2,'3ª série')`, [idAlu, aluno]);
    await db.query(
      `INSERT INTO acordos (id,numero,valor_total_cts,modo_assinatura,criado_por,cancelado,
                            snapshot_assinatura_json,atualizado_em)
       VALUES ($1,$2,100000,'fisico',$3,$4,'{"partes":"com PII"}',$5)`,
      [idAco, `2020/${seq}`, ADMIN, cancelado, vencimento]);
    await db.query(`INSERT INTO acordo_devedores (acordo_id,devedor_id,papel,ordem) VALUES ($1,$2,'devedor',1)`, [idAco, idDev]);
    await db.query(`INSERT INTO acordo_alunos (acordo_id,aluno_id) VALUES ($1,$2)`, [idAco, idAlu]);
    await db.query(
      `INSERT INTO parcelas (id,acordo_id,numero,vencimento,valor_previsto_cts,valor_pago_cts,data_pagamento)
       VALUES ($1,$2,1,$3,100000,$4,$5)`,
      [idPar, idAco, vencimento, pago ? 100000 : null, pago ? vencimento : null]);
    return { idDev, idAlu, idAco };
  }

  // ── [1] O que deve ser expurgado ─────────────────────────────────────────
  grupo('[1] Acordo quitado há muito tempo é expurgado');
  const antigo = await cenario({ devedor: 'Antigo Quitado', aluno: 'Aluno Antigo', cpf: '11144477735', pago: true, vencimento: anosAtras(8) });
  {
    const ensaio = await executarRetencao(db, { dryRun: true, anos: 5 });
    assert('ensaio encontra o devedor', ensaio.devedores === 1);
    assert('ensaio encontra o aluno',   ensaio.alunos === 1);
    assert('ensaio encontra o snapshot', ensaio.snapshots === 1);
    assert('ensaio não aplica',          ensaio.aplicado === false);

    const { rows } = await db.query('SELECT nome FROM devedores WHERE id = $1', [antigo.idDev]);
    assert('ensaio realmente não alterou nada', rows[0].nome === 'Antigo Quitado');
    assert('CPF da amostra vem mascarado', /^\*\*\*\./.test(ensaio.amostra.devedores[0].cpf));
  }

  // ── [2] O que NÃO pode ser tocado ────────────────────────────────────────
  grupo('[2] O que o expurgo precisa preservar');
  const emAberto  = await cenario({ devedor: 'Em Aberto',  aluno: 'Aluno Aberto',  cpf: '52998224725', pago: false, vencimento: anosAtras(8) });
  const recente   = await cenario({ devedor: 'Quitou Ontem', aluno: 'Aluno Recente', cpf: '87748248800', pago: true,  vencimento: anosAtras(1) });
  {
    const ensaio = await executarRetencao(db, { dryRun: true, anos: 5 });
    assert('inadimplente antigo NÃO entra (acordo não encerrado)',
      !ensaio.amostra.devedores.some(d => d.nome === 'Em Aberto'));
    assert('quitado recente NÃO entra', !ensaio.amostra.devedores.some(d => d.nome === 'Quitou Ontem'));
    assert('só o antigo quitado entra', ensaio.devedores === 1);
  }

  // ── [3] Um acordo recente preserva a pessoa inteira ──────────────────────
  grupo('[3] Devedor com acordo antigo E recente é preservado');
  {
    const idAco2 = U(90);
    await db.query(
      `INSERT INTO acordos (id,numero,valor_total_cts,modo_assinatura,criado_por,atualizado_em)
       VALUES ($1,'2026/900',100000,'fisico',$2,$3)`, [idAco2, ADMIN, anosAtras(0)]);
    await db.query(`INSERT INTO acordo_devedores (acordo_id,devedor_id,papel,ordem) VALUES ($1,$2,'devedor',1)`, [idAco2, antigo.idDev]);
    await db.query(
      `INSERT INTO parcelas (id,acordo_id,numero,vencimento,valor_previsto_cts)
       VALUES ($1,$2,1,$3,100000)`, [U(91), idAco2, anosAtras(0)]);

    const ensaio = await executarRetencao(db, { dryRun: true, anos: 5 });
    assert('nenhum devedor elegível agora', ensaio.devedores === 0);
    assert('mas o aluno do acordo antigo segue elegível', ensaio.alunos === 1);

    // desfaz para os testes seguintes
    await db.query('DELETE FROM parcelas WHERE acordo_id = $1', [idAco2]);
    await db.query('DELETE FROM acordo_devedores WHERE acordo_id = $1', [idAco2]);
    await db.query('DELETE FROM acordos WHERE id = $1', [idAco2]);
  }

  // ── [4] Aplicação ────────────────────────────────────────────────────────
  grupo('[4] Aplicando o expurgo');
  {
    const r = await executarRetencao(db, { dryRun: false, anos: 5 });
    assert('aplicou', r.aplicado === true);
    assert('1 devedor, 1 aluno, 1 snapshot', r.devedores === 1 && r.alunos === 1 && r.snapshots === 1);

    const { rows: d } = await db.query(
      'SELECT nome, cpf, email, telefone, end_logradouro, anonimizado_em FROM devedores WHERE id = $1', [antigo.idDev]);
    assert('nome removido',      d[0].nome.includes('removidos'));
    assert('e-mail removido',    d[0].email === null);
    assert('telefone removido',  d[0].telefone === null);
    assert('endereço removido',  d[0].end_logradouro === null);
    assert('CPF vira marcador único', d[0].cpf.startsWith('ANON-'));
    assert('marcado com anonimizado_em', d[0].anonimizado_em !== null);

    const { rows: a } = await db.query('SELECT nome, serie, ra FROM alunos WHERE id = $1', [antigo.idAlu]);
    assert('aluno anonimizado', a[0].nome.includes('removidos') && a[0].serie === null);

    const { rows: ac } = await db.query('SELECT snapshot_assinatura_json, numero, valor_total_cts FROM acordos WHERE id = $1', [antigo.idAco]);
    assert('snapshot limpo', ac[0].snapshot_assinatura_json === null);
    assert('o acordo em si sobrevive', ac[0].numero !== null && String(ac[0].valor_total_cts) === '100000');

    const { rows: p } = await db.query('SELECT COUNT(*)::int n FROM parcelas WHERE acordo_id = $1', [antigo.idAco]);
    assert('parcelas preservadas — registro financeiro fica', p[0].n === 1);

    const { rows: aud } = await db.query(`SELECT tabela, motivo FROM auditoria_exclusoes WHERE motivo LIKE 'Retencao%'`);
    assert('registrado em auditoria', aud.length === 2);
    assert('motivo cita o prazo', /5 anos/.test(aud[0].motivo));

    // Os preservados continuam intactos
    const { rows: viv } = await db.query('SELECT nome FROM devedores WHERE id IN ($1,$2) ORDER BY nome', [emAberto.idDev, recente.idDev]);
    assert('inadimplente antigo intacto', viv.some(r => r.nome === 'Em Aberto'));
    assert('quitado recente intacto',     viv.some(r => r.nome === 'Quitou Ontem'));
  }

  // ── [5] Idempotência ─────────────────────────────────────────────────────
  grupo('[5] Rodar de novo não repete nem quebra');
  {
    const r = await executarRetencao(db, { dryRun: false, anos: 5 });
    assert('nada mais a fazer', r.devedores === 0 && r.alunos === 0);
    const { rows } = await db.query(`SELECT COUNT(*)::int n FROM auditoria_exclusoes WHERE motivo LIKE 'Retencao%'`);
    assert('auditoria não duplicou', rows[0].n === 2);
  }

  // ── [6] Prazo configurável ───────────────────────────────────────────────
  grupo('[6] O prazo muda o corte');
  {
    const curto = await executarRetencao(db, { dryRun: true, anos: 1 });
    assert('com 1 ano, o quitado recente passa a entrar',
      curto.amostra.devedores.some(d => d.nome === 'Quitou Ontem'));
    const longo = await executarRetencao(db, { dryRun: true, anos: 50 });
    assert('com 50 anos, ninguém entra', longo.devedores === 0);
  }

  grupo('[7] Máscara de CPF não vaza o número');
  {
    assert('mostra só o miolo', mascararCpf('11144477735') === '***.444.777-**');
    assert('sem CPF não quebra', mascararCpf(null) === '(sem cpf)');
  }

  await db.close();
  console.log(`\nResultado: ${passou} ✓  ${falhou} ✗`);
  if (falhou > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
