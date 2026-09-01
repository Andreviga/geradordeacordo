#!/usr/bin/env node
'use strict';
// scripts/test-restore-integrado.js — prova de ida e volta do backup/restore
// contra um Postgres de verdade. É o "teste de restore" que o README pedia
// trimestralmente, automatizado.
//
//   npm run test:restore                 → PGlite (Postgres em WASM, no processo)
//   npm run test:restore -- --postgres   → usa o DATABASE_URL do .env.local
//
// O padrão é PGlite: não precisa de Docker, de servidor nem de rede, e roda
// igual em qualquer máquina e em CI. O modo --postgres existe para conferir
// contra o Postgres real de tempos em tempos; ele só aceita localhost ou
// BANCO_TESTE_HOST, porque apaga dados de propósito.
//
// O que o teste prova, nesta ordem:
//   1. semeia dados cobrindo as 13 tabelas e os tipos que importam
//      (JSONB, DATE, TIMESTAMPTZ, BIGINT em centavos, FK, acentuação)
//   2. gera um dump no formato exato do api/cron/_backup_engine.js
//   3. destrói e adultera os dados
//   4. restaura com o mesmo núcleo que o npm run db:restore usa
//   5. compara linha a linha com o original — igualdade profunda

const assert = require('assert');
const zlib   = require('zlib');
const fs     = require('fs');
const path   = require('path');

const { TABELAS } = require('../api/cron/_backup_engine');
const { executarRestore, conferirSchema, ordemDeRestauracao } = require('./db-restore');

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m' };
let passou = 0, falhou = 0;
const ok  = m => { console.log(`  ${C.g}✓${C.x} ${m}`); passou++; };
const nok = m => { console.error(`  ${C.r}✗${C.x} ${m}`); falhou++; };

const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── Alvos ─────────────────────────────────────────────────────────────────────

async function alvoPGlite() {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();                       // em memória; morre com o processo
  await db.waitReady;
  const sql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  await db.exec(sql);
  return {
    nome: 'PGlite (Postgres em WASM, em memória)',
    client: db,
    async versao() {
      const { rows } = await db.query('SELECT version() v');
      return rows[0].v.split(',')[0];
    },
    async fechar() { await db.close(); },
  };
}

async function alvoPostgres() {
  require('./db-utils').loadEnv();
  const { getPool } = require('../api/_db');
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL nao configurado.'); process.exit(1); }

  let host = '';
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  const testeHost = (process.env.BANCO_TESTE_HOST || '').trim();
  const ehLocal   = ['localhost', '127.0.0.1', '::1'].includes(host);
  const ehTeste   = testeHost && host === testeHost;

  if (!ehLocal && !ehTeste && !process.argv.includes('--descartavel')) {
    console.error(`\n${C.r}⛔  Recusando: "${host}" nao e localhost nem BANCO_TESTE_HOST.${C.x}`);
    console.error(`${C.d}   Este teste APAGA e reescreve dados. Se o banco e descartavel mesmo,`);
    console.error(`   rode com --descartavel.${C.x}\n`);
    process.exit(1);
  }

  const pool   = getPool();
  const client = await pool.connect();
  return {
    nome: `Postgres em ${host}`,
    client,
    async versao() {
      const { rows } = await client.query('SELECT version() v');
      return rows[0].v.split(',')[0];
    },
    async fechar() { client.release(); await pool.end(); },
  };
}

// ── Semeadura ─────────────────────────────────────────────────────────────────
async function semear(q) {
  await q(`INSERT INTO usuarios (id,nome,email,hash_senha,papel,ativo)
           VALUES ($1,'Teste Restore','restore-teste@exemplo.invalido','$2a$10$x','admin',true)`, [U(1)]);
  await q(`INSERT INTO devedores (id,nome,cpf,rg,end_logradouro,end_cep,end_cidade,email,telefone)
           VALUES ($1,'Devedor Acentuação Ção','11144477735','12.345.678-9','Rua das Flores, 1',
                   '01234-567','São Paulo','d@exemplo.invalido','(11)90000-0000')`, [U(2)]);
  await q(`INSERT INTO credoras (id,nome,cnpj,tipo) VALUES ($1,'Colégio Teste S/S Ltda','59946400000187','pj')`, [U(3)]);
  await q(`INSERT INTO alunos (id,nome,serie,turno) VALUES ($1,'Aluno Teste','3ª série','manhã')`, [U(4)]);
  await q(`INSERT INTO acordos (id,numero,valor_total_cts,entrada_cts,n_parcelas,valor_parcela_cts,
             data_primeira_parcela,multa_mora_pct,origem_divida,modo_assinatura,criado_por,
             data_assinatura,snapshot_assinatura_json)
           VALUES ($1,'2026/999',1491950,50000,29,50000,'2026-09-10',2.00,'mensalidades','eletronico',$2,
                   '2026-08-01','{"prova":"legal","itens":[1,2,3]}')`, [U(5), U(1)]);
  await q(`INSERT INTO acordo_numero_seq (ano,ultimo) VALUES (2026,999)`);
  await q(`INSERT INTO acordo_devedores (acordo_id,devedor_id,papel,ordem) VALUES ($1,$2,'devedor',1)`, [U(5), U(2)]);
  await q(`INSERT INTO acordo_credoras (acordo_id,credora_id,valor_cts) VALUES ($1,$2,1491950)`, [U(5), U(3)]);
  await q(`INSERT INTO acordo_alunos (acordo_id,aluno_id) VALUES ($1,$2)`, [U(5), U(4)]);
  for (let i = 1; i <= 29; i++) {
    const pago = i <= 3;
    await q(`INSERT INTO parcelas (id,acordo_id,numero,vencimento,valor_previsto_cts,
               valor_pago_cts,data_pagamento,forma_pagamento,registrado_por)
             VALUES ($1,$2,$3,$4,50000,$5,$6,$7,$8)`,
      [U(100 + i), U(5), i, `2026-${String(9 + (i % 4)).padStart(2, '0')}-10`,
       pago ? 50000 : null, pago ? '2026-09-11' : null, pago ? 'pix' : null, pago ? U(1) : null]);
  }
  await q(`INSERT INTO auditoria_exclusoes (tabela,registro_id,excluido_por,motivo)
           VALUES ('baixas',$1,$2,'Estorno: teste de restore')`, [U(101), U(1)]);
}

// ── Principal ─────────────────────────────────────────────────────────────────
async function main() {
  const usarPostgres = process.argv.includes('--postgres');

  console.log(`\n${C.b}test-restore-integrado${C.x}`);
  console.log('─'.repeat(62));

  const alvo = usarPostgres ? await alvoPostgres() : await alvoPGlite();
  const q = (sql, params) => alvo.client.query(sql, params);

  console.log(`  Alvo   : ${alvo.nome}`);
  console.log(`  Motor  : ${await alvo.versao()}\n`);

  try {
    // ── 1. Semear ────────────────────────────────────────────────────────────
    console.log(`${C.b}[1] Semeando dados sintéticos${C.x}`);
    await q(`TRUNCATE ${TABELAS.map(t => `"${t}"`).join(', ')} CASCADE`);
    await semear(q);
    ok('13 tabelas semeadas (JSONB, DATE, BIGINT, FK, acentuação)');

    const antes = {};
    for (const t of TABELAS) {
      const { rows } = await q(`SELECT * FROM "${t}" ORDER BY 1`);
      antes[t] = rows;
    }
    const totalAntes = Object.values(antes).reduce((s, r) => s + r.length, 0);
    ok(`fotografia do original: ${totalAntes} linhas`);

    // ── 2. Dump no formato do engine ─────────────────────────────────────────
    console.log(`\n${C.b}[2] Gerando backup no formato do cron${C.x}`);
    const dump = { _meta: { gerado_em: new Date().toISOString(), tabelas: TABELAS }, dados: antes };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(dump)));
    // Ida e volta pelo gzip: é assim que o arquivo chega do Drive
    const dumpLido = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
    ok(`dump gerado e relido do gzip: ${(gz.length / 1024).toFixed(1)} KB`);

    // ── 3. Destruir ──────────────────────────────────────────────────────────
    console.log(`\n${C.b}[3] Destruindo e adulterando${C.x}`);
    await q('DELETE FROM parcelas WHERE numero > 10');
    await q(`UPDATE acordos SET valor_total_cts = 1, numero = 'ADULTERADO', snapshot_assinatura_json = NULL`);
    await q(`UPDATE devedores SET nome = 'APAGADO', cpf = '00000000000'`);
    await q('DELETE FROM auditoria_exclusoes');
    const { rows: dep } = await q('SELECT COUNT(*)::int n FROM parcelas');
    ok(`parcelas 29 → ${dep[0].n}, acordo e devedor adulterados, auditoria zerada`);

    // ── 4. Restaurar com o núcleo do db:restore ──────────────────────────────
    console.log(`\n${C.b}[4] Restaurando (mesmo núcleo do npm run db:restore)${C.x}`);
    const ordem = ordemDeRestauracao(dumpLido, TABELAS);
    const { problemas } = await conferirSchema(alvo.client, ordem, dumpLido);
    if (problemas.length) { problemas.forEach(nok); throw new Error('schema incompatível'); }
    ok(`conferência de schema passou em ${ordem.length} tabelas`);

    const r = await executarRestore(alvo.client, ordem, dumpLido, {});
    if (r.divergencias.length) { r.divergencias.forEach(nok); throw new Error('contagens divergentes'); }
    if (!r.commitado) throw new Error('restore não commitou');
    ok(`restore commitado em ${r.ms}ms`);

    // ── 5. Comparar ──────────────────────────────────────────────────────────
    console.log(`\n${C.b}[5] Conferindo igualdade profunda${C.x}`);
    let divergentes = 0;
    for (const t of TABELAS) {
      const { rows } = await q(`SELECT * FROM "${t}" ORDER BY 1`);
      try {
        assert.deepStrictEqual(
          JSON.parse(JSON.stringify(rows)),
          JSON.parse(JSON.stringify(antes[t])));
        console.log(`  ${C.d}·${C.x} ${t.padEnd(22)} ${String(rows.length).padStart(4)} linha(s) idênticas`);
      } catch (e) {
        nok(`"${t}" divergiu após o restore`);
        console.error(`${C.d}${String(e.message).slice(0, 400)}${C.x}`);
        divergentes++;
      }
    }
    if (!divergentes) ok('todas as 13 tabelas voltaram idênticas');

    // Provas pontuais do que mais importa
    const { rows: ac } = await q(`SELECT numero, valor_total_cts, snapshot_assinatura_json FROM acordos WHERE id = $1`, [U(5)]);
    if (ac[0] && ac[0].numero === '2026/999') ok('numero do acordo restaurado (era ADULTERADO)');
    else nok('numero do acordo nao voltou');
    if (ac[0] && String(ac[0].valor_total_cts) === '1491950') ok('BIGINT em centavos preservado (1491950)');
    else nok(`BIGINT divergiu: ${ac[0] && ac[0].valor_total_cts}`);
    const snap = ac[0] && ac[0].snapshot_assinatura_json;
    const snapObj = typeof snap === 'string' ? JSON.parse(snap) : snap;
    if (snapObj && snapObj.prova === 'legal' && Array.isArray(snapObj.itens))
      ok('JSONB restaurado com estrutura intacta');
    else nok('JSONB nao voltou: ' + JSON.stringify(snap));

    const { rows: dv } = await q(`SELECT nome, cpf FROM devedores WHERE id = $1`, [U(2)]);
    if (dv[0] && dv[0].nome === 'Devedor Acentuação Ção') ok('acentuação preservada na ida e volta');
    else nok(`acentuacao divergiu: ${dv[0] && dv[0].nome}`);

    const { rows: pg } = await q(`SELECT COUNT(*)::int n FROM parcelas WHERE valor_pago_cts IS NOT NULL`);
    if (pg[0].n === 3) ok('baixas de parcela restauradas (3 pagas)');
    else nok(`baixas divergiram: ${pg[0].n}`);

    // As views derivadas voltam a funcionar sobre os dados restaurados
    const { rows: v } = await q(`SELECT status FROM acordos_com_status WHERE id = $1`, [U(5)]);
    if (v[0]) ok(`views derivadas funcionam após o restore (status: ${v[0].status})`);
    else nok('view acordos_com_status nao devolveu o acordo');

    if (usarPostgres) {
      await q(`TRUNCATE ${TABELAS.map(t => `"${t}"`).join(', ')} CASCADE`);
      ok('banco de teste limpo ao final');
    }
  } catch (e) {
    nok(`erro: ${e.message}`);
  } finally {
    await alvo.fechar().catch(() => {});
  }

  console.log(`\n${falhou ? C.r : C.g}${C.b}Resultado: ${passou} ✓  ${falhou} ✗${C.x}\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
