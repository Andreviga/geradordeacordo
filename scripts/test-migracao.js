#!/usr/bin/env node
'use strict';
// scripts/test-migracao.js — testa migração contra banco com estrutura anterior
//
// Simula o cenário real: banco existente com views na ordem "antiga" (p.*, a.*),
// aplica a seção de views do schema.sql atual, verifica que o resultado está certo.
// Tudo dentro de BEGIN/ROLLBACK — sem alterar o banco permanentemente.
//
// Uso: npm run test:migracao

require('./db-utils').loadEnv();
const fs   = require('fs');
const path = require('path');
const { getPool } = require('../api/_db');

const OK   = (s) => process.stdout.write(`  \x1b[32m✓\x1b[0m ${s}\n`);
const FAIL = (s, d) => { erros++; process.stderr.write(`  \x1b[31m✗\x1b[0m ${s}\n`); if (d) process.stderr.write(`      → ${d}\n`); };
let erros = 0;

// Guarda: este teste altera o banco temporariamente (revertendo com ROLLBACK).
// Deve rodar apenas contra o banco de testes para não correr risco.
const rawUrl   = process.env.DATABASE_URL || '';
let bancoHost  = '?';
try { bancoHost = new URL(rawUrl).hostname; } catch {}
const testeHost = (process.env.BANCO_TESTE_HOST || '').trim();
if (testeHost && bancoHost !== testeHost) {
  console.error(`\n⛔ Host atual (${bancoHost}) ≠ banco de testes (${testeHost}).`);
  console.error('   test:migracao altera o banco temporariamente — só roda contra o banco de testes.\n');
  process.exit(1);
}

// Extrai a seção de views do schema.sql (DROP + CREATE VIEW)
function extrairSqlViews() {
  const raw = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  const ini = raw.indexOf('-- DROP antes de CREATE');
  const fim = raw.indexOf('\n-- Funções auxiliares', ini);
  if (ini === -1 || fim === -1) throw new Error('Seção de views não encontrada no schema.sql');
  return raw.slice(ini, fim).trim();
}

// View antiga estilo p.* — simula o que está em produção antes da migração
const SQL_VIEWS_ANTIGAS = `
  DROP VIEW IF EXISTS devedores_sem_email;
  DROP VIEW IF EXISTS acordos_com_status;
  DROP VIEW IF EXISTS parcelas_com_status;

  CREATE VIEW parcelas_com_status AS
  SELECT p.*,
    (p.vencimento - CURRENT_DATE) AS dias_para_vencimento,
    CASE
      WHEN p.renegociada                                          THEN 'renegociada'
      WHEN p.valor_pago_cts >= p.valor_previsto_cts               THEN 'pago'
      WHEN p.valor_pago_cts IS NOT NULL AND p.valor_pago_cts > 0  THEN 'pago_parcial'
      WHEN p.vencimento < CURRENT_DATE                            THEN 'vencido'
      ELSE 'a_vencer'
    END AS status,
    GREATEST(0, p.valor_previsto_cts - COALESCE(p.valor_pago_cts, 0)) AS saldo_cts
  FROM parcelas p;

  CREATE VIEW acordos_com_status AS
  SELECT a.*,
    CASE WHEN a.cancelado THEN 'cancelado'
         WHEN NOT EXISTS (SELECT 1 FROM parcelas WHERE acordo_id=a.id) THEN 'rascunho'
         WHEN NOT EXISTS (SELECT 1 FROM parcelas_com_status pcs
                          WHERE pcs.acordo_id=a.id
                            AND pcs.status NOT IN ('pago','renegociada')) THEN 'quitado'
         WHEN EXISTS (SELECT 1 FROM parcelas_com_status pcs
                      WHERE pcs.acordo_id=a.id AND pcs.status='vencido') THEN 'inadimplente'
         ELSE 'ativo' END AS status,
    COALESCE((SELECT SUM(saldo_cts) FROM parcelas_com_status pcs
              WHERE pcs.acordo_id=a.id AND pcs.status NOT IN ('pago','renegociada')), 0) AS saldo_total_cts,
    (SELECT MIN(vencimento) FROM parcelas_com_status pcs
     WHERE pcs.acordo_id=a.id AND pcs.status='a_vencer') AS proximo_vencimento
  FROM acordos a;

  CREATE VIEW devedores_sem_email AS
  SELECT d.id, d.nome, d.cpf, d.telefone, d.email, d.email_valido,
    COUNT(DISTINCT ad.acordo_id) AS n_acordos_ativos
  FROM devedores d
  JOIN acordo_devedores ad ON ad.devedor_id = d.id
  JOIN acordos_com_status acs ON acs.id = ad.acordo_id
  WHERE (d.email IS NULL OR d.email_valido = false)
    AND acs.status IN ('ativo', 'inadimplente')
  GROUP BY d.id, d.nome, d.cpf, d.telefone, d.email, d.email_valido;
`;

// Colunas esperadas nas views após a migração
const COLUNAS_ESPERADAS = {
  parcelas_com_status: [
    'id','acordo_id','numero','vencimento','valor_previsto_cts','valor_pago_cts',
    'data_pagamento','referencia_pag','observacao','registrado_por','renegociada',
    'tratamento_manual','tratamento_manual_motivo','forma_pagamento','estornado_em',
    'estornado_por','motivo_estorno','classificacao_excedente',
    'dias_para_vencimento','status','saldo_cts','valor_excedente_cts',
  ],
  acordos_com_status: [
    'id','numero','cancelado','valor_total_cts','entrada_cts','n_parcelas',
    'valor_parcela_cts','data_primeira_parcela','multa_mora_pct','juros_pct',
    'multa_penal_pct','honorarios_pct','indice_correcao','origem_divida',
    'periodo_referencia','foro','modo_assinatura','zapsign_token','assinado_em',
    'drive_file_id','snapshot_assinatura_json','lembretes_ativos',
    'lembretes_desativado_por','acordo_pai_id','criado_por','criado_em',
    'atualizado_em','idempotency_key','data_assinatura',
    'status','saldo_total_cts','proximo_vencimento',
  ],
};

async function main() {
  const pool = getPool();
  if (!pool) { console.error('DATABASE_URL não configurado'); process.exit(1); }

  const rawUrl = process.env.DATABASE_URL || '';
  let host = '?';
  try { host = new URL(rawUrl).hostname; } catch {}
  console.log(`\nTeste de migração incremental\nBanco: \x1b[1m${host}\x1b[0m\n${'─'.repeat(44)}`);
  console.log('  Tudo dentro de BEGIN/ROLLBACK — banco não é alterado permanentemente.\n');

  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    // ── Cenário: banco com views na ordem "antiga" (p.*, a.*) ─────────────
    process.stdout.write('[1/3] Criando estado anterior (views com p.*) ...');
    await client.query(SQL_VIEWS_ANTIGAS);
    process.stdout.write(' OK\n');

    // Verificar que a view antiga não tem as colunas explícitas no lugar certo
    const { rows: colsAntes } = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='parcelas_com_status'
      ORDER BY ordinal_position
    `);
    const temColunasAntigas = !colsAntes.some(r => r.column_name === 'valor_excedente_cts');
    if (temColunasAntigas) OK('Estado anterior simulado: view antiga sem valor_excedente_cts');
    else FAIL('Estado anterior: view deveria não ter valor_excedente_cts');

    // ── Aplicar a seção de views do schema.sql atual ──────────────────────
    process.stdout.write('[2/3] Aplicando migração (schema.sql seção de views) ...');
    const sqlViews = extrairSqlViews();
    await client.query(sqlViews);
    process.stdout.write(' OK\n');

    // ── Verificar resultado ────────────────────────────────────────────────
    process.stdout.write('[3/3] Verificando resultado ...\n');
    for (const [viewName, esperado] of Object.entries(COLUNAS_ESPERADAS)) {
      const { rows } = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1
        ORDER BY ordinal_position
      `, [viewName]);
      const atual = rows.map(r => r.column_name);
      const divergencias = esperado.filter((c, i) => atual[i] !== c);
      if (divergencias.length === 0) {
        OK(`${viewName}: ${esperado.length} colunas na ordem correta`);
      } else {
        FAIL(`${viewName}: ordem diverge`,
          `esperado [..., ${divergencias[0]}, ...] na posição ${esperado.indexOf(divergencias[0])}, encontrado ${atual[esperado.indexOf(divergencias[0])] || '(ausente)'}`);
      }
    }

    // Garantia: as 3 views existem e são consultáveis após a migração
    for (const view of ['parcelas_com_status', 'acordos_com_status', 'devedores_sem_email']) {
      try {
        await client.query(`SELECT 1 FROM ${view} LIMIT 0`);
        OK(`${view}: consultável após migração`);
      } catch (e) {
        FAIL(`${view}: falhou ao consultar`, e.message);
      }
    }

  } finally {
    await client.query('ROLLBACK');
    console.log('\n  ROLLBACK executado — banco restaurado ao estado original.\n');
    client.release();
  }

  console.log('─'.repeat(44));
  if (erros === 0) {
    console.log('\x1b[32mTeste de migração incremental: PASSOU\x1b[0m\n');
    console.log('  A migração funciona corretamente sobre banco com views em ordem antiga.\n');
    process.exit(0);
  } else {
    console.error(`\x1b[31mFalhas: ${erros}\x1b[0m\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\nERRO INESPERADO:', err.message);
  process.exit(1);
});
