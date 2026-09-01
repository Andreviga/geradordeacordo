#!/usr/bin/env node
'use strict';
// scripts/test-restore-integrado.js — prova de ida e volta do backup/restore
// contra um Postgres de verdade. É o "teste de restore" que o README pede
// trimestralmente, automatizado.
//
//   node scripts/test-restore-integrado.js [--descartavel]
//
// Trava de segurança: só roda se o host do DATABASE_URL for localhost, igual a
// BANCO_TESTE_HOST, ou se vier --descartavel. NUNCA rode contra produção: este
// script grava e apaga dados de propósito.
//
// O que ele prova, nesta ordem:
//   1. semeia dados sintéticos cobrindo todas as tabelas e tipos (JSONB, datas,
//      BIGINT em centavos, FK entre acordo/parcela/devedor)
//   2. gera um dump no formato exato do api/cron/_backup_engine.js
//   3. destrói e adultera os dados (apaga linhas, altera valores)
//   4. restaura o dump
//   5. compara linha a linha com o que foi semeado — igualdade profunda

const assert = require('assert');
const zlib   = require('zlib');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

require('./db-utils').loadEnv();
const { getPool } = require('../api/_db');
const { TABELAS } = require('../api/cron/_backup_engine');

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m' };
let passou = 0, falhou = 0;
const ok   = m => { console.log(`  ${C.g}✓${C.x} ${m}`); passou++; };
const nok  = m => { console.error(`  ${C.r}✗${C.x} ${m}`); falhou++; };

const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL não configurado.'); process.exit(1); }

  let host = '';
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  const testeHost  = (process.env.BANCO_TESTE_HOST || '').trim();
  const ehLocal    = ['localhost', '127.0.0.1', '::1'].includes(host);
  const ehTeste    = testeHost && host === testeHost;
  const forcado    = process.argv.includes('--descartavel');

  console.log(`\n${C.b}test-restore-integrado${C.x}`);
  console.log('─'.repeat(62));
  console.log(`  Alvo: ${C.b}${host}${C.x}`);

  if (!ehLocal && !ehTeste && !forcado) {
    console.error(`\n${C.r}⛔  Recusando: "${host}" não é localhost nem BANCO_TESTE_HOST.${C.x}`);
    console.error(`${C.d}   Este teste APAGA e reescreve dados. Se o banco é descartável mesmo,`);
    console.error(`   rode com --descartavel.${C.x}\n`);
    process.exit(1);
  }
  console.log(`  ${C.d}${ehLocal ? 'localhost' : ehTeste ? 'BANCO_TESTE_HOST' : '--descartavel'}${C.x}\n`);

  const pool = getPool();
  const cli  = await pool.connect();
  const arquivos = [];

  try {
    // ── 1. Semear ────────────────────────────────────────────────────────────
    console.log(`${C.b}[1] Semeando dados sintéticos${C.x}`);
    await cli.query(`TRUNCATE ${TABELAS.map(t => `"${t}"`).join(', ')} CASCADE`);

    await cli.query(
      `INSERT INTO usuarios (id,nome,email,hash_senha,papel,ativo)
       VALUES ($1,'Teste Restore','restore-teste@exemplo.invalido','$2a$10$x','admin',true)`, [U(1)]);
    await cli.query(
      `INSERT INTO devedores (id,nome,cpf,rg,end_logradouro,end_cep,end_cidade,email,telefone)
       VALUES ($1,'Devedor Acentuação Ção','11144477735','12.345.678-9','Rua das Flores, 1','01234-567','São Paulo','d@exemplo.invalido','(11)90000-0000')`, [U(2)]);
    await cli.query(
      `INSERT INTO credoras (id,nome,cnpj,tipo) VALUES ($1,'Colégio Teste S/S Ltda','59946400000187','pj')`, [U(3)]);
    await cli.query(`INSERT INTO alunos (id,nome,serie,turno) VALUES ($1,'Aluno Teste','3ª série','manhã')`, [U(4)]);
    await cli.query(
      `INSERT INTO acordos (id,numero,valor_total_cts,entrada_cts,n_parcelas,valor_parcela_cts,
         data_primeira_parcela,multa_mora_pct,origem_divida,modo_assinatura,criado_por,
         data_assinatura,snapshot_assinatura_json)
       VALUES ($1,'2026/999',1491950,50000,29,50000,'2026-09-10',2.00,'mensalidades','eletronico',$2,
               '2026-08-01','{"prova":"legal","itens":[1,2,3]}'::jsonb)`, [U(5), U(1)]);
    await cli.query(`INSERT INTO acordo_numero_seq (ano,ultimo) VALUES (2026,999)`);
    await cli.query(`INSERT INTO acordo_devedores (acordo_id,devedor_id,papel,ordem) VALUES ($1,$2,'devedor',1)`, [U(5), U(2)]);
    await cli.query(`INSERT INTO acordo_credoras (acordo_id,credora_id,valor_cts) VALUES ($1,$2,1491950)`, [U(5), U(3)]);
    await cli.query(`INSERT INTO acordo_alunos (acordo_id,aluno_id) VALUES ($1,$2)`, [U(5), U(4)]);
    for (let i = 1; i <= 29; i++) {
      await cli.query(
        `INSERT INTO parcelas (id,acordo_id,numero,vencimento,valor_previsto_cts,valor_pago_cts,data_pagamento,forma_pagamento,registrado_por)
         VALUES ($1,$2,$3,$4,50000,$5,$6,$7,$8)`,
        [U(100 + i), U(5), i, `2026-${String(9 + (i % 4)).padStart(2, '0')}-10`,
         i <= 3 ? 50000 : null, i <= 3 ? '2026-09-11' : null, i <= 3 ? 'pix' : null, i <= 3 ? U(1) : null]);
    }
    await cli.query(
      `INSERT INTO auditoria_exclusoes (tabela,registro_id,excluido_por,motivo)
       VALUES ('baixas',$1,$2,'Estorno: teste de restore')`, [U(101), U(1)]);
    ok('12 tabelas semeadas (JSONB, datas, BIGINT, FK, acentuação)');

    // Fotografia do estado semeado
    const antes = {};
    for (const t of TABELAS) {
      const { rows } = await cli.query(`SELECT * FROM "${t}" ORDER BY 1`);
      antes[t] = rows;
    }
    const totalAntes = Object.values(antes).reduce((s, r) => s + r.length, 0);
    ok(`fotografia: ${totalAntes} linhas em ${TABELAS.length} tabelas`);

    // ── 2. Gerar dump no formato do engine ───────────────────────────────────
    console.log(`\n${C.b}[2] Gerando backup no formato do _backup_engine${C.x}`);
    const dump = { _meta: { gerado_em: new Date().toISOString(), tabelas: TABELAS }, dados: antes };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(dump)));
    const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-int-')), 'backup-teste.json.gz');
    fs.writeFileSync(arq, gz);
    arquivos.push(arq);
    ok(`dump gerado: ${(gz.length / 1024).toFixed(1)} KB comprimido`);

    // ── 3. Destruir ──────────────────────────────────────────────────────────
    console.log(`\n${C.b}[3] Destruindo e adulterando os dados${C.x}`);
    await cli.query('DELETE FROM parcelas WHERE numero > 10');
    await cli.query(`UPDATE acordos SET valor_total_cts = 1, numero = 'ADULTERADO', snapshot_assinatura_json = NULL`);
    await cli.query(`UPDATE devedores SET nome = 'APAGADO', cpf = '00000000000'`);
    await cli.query('DELETE FROM auditoria_exclusoes');
    const { rows: dep } = await cli.query('SELECT COUNT(*)::int n FROM parcelas');
    ok(`parcelas reduzidas para ${dep[0].n}, acordo e devedor adulterados, auditoria apagada`);

    // ── 4. Restaurar pelo script de verdade ──────────────────────────────────
    console.log(`\n${C.b}[4] Rodando npm run db:restore${C.x}`);
    cli.release();
    const saida = execFileSync(process.execPath,
      [path.join(__dirname, 'db-restore.js'), arq, '--sim'],
      { encoding: 'utf8', env: process.env });
    const linhasOk = (saida.match(/✓/g) || []).length;
    if (!/Restore concluido/.test(saida)) throw new Error('script não reportou conclusão:\n' + saida.slice(-600));
    ok(`script concluiu (${linhasOk} verificações internas)`);

    // ── 5. Comparar ──────────────────────────────────────────────────────────
    console.log(`\n${C.b}[5] Conferindo igualdade profunda${C.x}`);
    const cli2 = await pool.connect();
    let divergentes = 0;
    for (const t of TABELAS) {
      const { rows } = await cli2.query(`SELECT * FROM "${t}" ORDER BY 1`);
      try {
        assert.deepStrictEqual(
          JSON.parse(JSON.stringify(rows)),
          JSON.parse(JSON.stringify(antes[t])));
        console.log(`  ${C.d}·${C.x} ${t.padEnd(22)} ${String(rows.length).padStart(4)} linha(s) idênticas`);
      } catch (e) {
        nok(`"${t}" divergiu após o restore`);
        console.error(`${C.d}${String(e.message).slice(0, 300)}${C.x}`);
        divergentes++;
      }
    }
    if (!divergentes) ok('todas as tabelas voltaram idênticas ao original');

    // Sanidade: as views derivadas voltaram a funcionar
    const { rows: v } = await cli2.query(`SELECT status FROM acordos_com_status WHERE id = $1`, [U(5)]);
    if (v[0]) ok(`views derivadas funcionam após restore (status: ${v[0].status})`);
    else nok('view acordos_com_status não devolveu o acordo restaurado');

    // Limpeza
    await cli2.query(`TRUNCATE ${TABELAS.map(t => `"${t}"`).join(', ')} CASCADE`);
    cli2.release();
    ok('banco de teste limpo ao final');
  } catch (e) {
    nok(`erro: ${e.message}`);
  } finally {
    arquivos.forEach(a => { try { fs.rmSync(path.dirname(a), { recursive: true, force: true }); } catch { /* ignore */ } });
    await pool.end().catch(() => {});
  }

  console.log(`\n${falhou ? C.r : C.g}${C.b}Resultado: ${passou} ✓  ${falhou} ✗${C.x}\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
