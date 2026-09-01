#!/usr/bin/env node
'use strict';
// scripts/cron-retencao.js — expurgo de dados pessoais (LGPD), pela linha de comando.
//
//   npm run cron:retencao                  → ensaio: lista quem seria anonimizado
//   npm run cron:retencao -- --anos=7      → ensaio com outro prazo
//   npm run cron:retencao -- --aplicar     → apaga de verdade (pede confirmação)
//
// O padrão é ensaio de propósito: a anonimização é irreversível e o dado
// removido não volta nem pelo backup, se o backup também já tiver sido rotacionado.

require('./db-utils').loadEnv();
const readline = require('readline');
const { getPool } = require('../api/_db');
const { executarRetencao, anosDeRetencao } = require('../api/cron/_retencao_engine');

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m' };

function perguntar(texto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(texto, r => { rl.close(); res(r.trim()); }));
}

async function main() {
  const argv    = process.argv.slice(2);
  const aplicar = argv.includes('--aplicar');
  const argAnos = argv.find(a => a.startsWith('--anos='));
  const anos    = argAnos ? parseInt(argAnos.slice(7), 10) : anosDeRetencao();

  if (!Number.isInteger(anos) || anos <= 0) {
    console.error('--anos precisa ser um inteiro positivo.');
    process.exit(1);
  }

  const pool = getPool();
  if (!pool) { console.error('DATABASE_URL não configurado.'); process.exit(1); }

  let host = '(desconhecido)';
  try { host = new URL(process.env.DATABASE_URL).hostname; } catch { /* ignore */ }

  console.log(`\n${C.b}Retenção de dados pessoais (LGPD)${C.x}`);
  console.log('─'.repeat(62));
  console.log(`  Banco : ${host}`);
  console.log(`  Prazo : ${anos} anos após o encerramento do acordo`);

  // Primeiro sempre o ensaio, mesmo quando a intenção é aplicar
  const ensaio = await executarRetencao(pool, { dryRun: true, anos });

  console.log(`  Corte : acordos encerrados até ${new Date(ensaio.corte).toLocaleDateString('pt-BR')}\n`);
  console.log(`  ${C.b}Devedores a anonimizar : ${ensaio.devedores}${C.x}`);
  ensaio.amostra.devedores.forEach(d => console.log(`    ${C.d}· ${d.nome} — ${d.cpf}${C.x}`));
  if (ensaio.devedores > 10) console.log(`    ${C.d}… e mais ${ensaio.devedores - 10}${C.x}`);

  console.log(`  ${C.b}Alunos a anonimizar    : ${ensaio.alunos}${C.x}`);
  ensaio.amostra.alunos.forEach(n => console.log(`    ${C.d}· ${n}${C.x}`));
  if (ensaio.alunos > 10) console.log(`    ${C.d}… e mais ${ensaio.alunos - 10}${C.x}`);

  console.log(`  ${C.b}Snapshots a limpar     : ${ensaio.snapshots}${C.x}`);
  ensaio.amostra.acordos.forEach(n => console.log(`    ${C.d}· acordo ${n}${C.x}`));

  const total = ensaio.devedores + ensaio.alunos + ensaio.snapshots;
  if (total === 0) {
    console.log(`\n${C.g}Nada vencido de prazo. Nenhuma ação necessária.${C.x}\n`);
    await pool.end();
    return;
  }

  if (!aplicar) {
    console.log(`\n${C.y}Ensaio — nada foi alterado.${C.x}`);
    console.log(`${C.d}Para aplicar: npm run cron:retencao -- --aplicar${C.x}\n`);
    await pool.end();
    return;
  }

  console.log(`\n${C.r}${C.b}  Isto apaga nome, CPF, RG, endereço, e-mail e telefone dessas pessoas.`);
  console.log(`  É irreversível: o dado não volta, nem por backup já rotacionado.${C.x}`);
  const resp = await perguntar(`\n  Digite ANONIMIZAR para confirmar: `);
  if (resp !== 'ANONIMIZAR') {
    console.log('\n  Cancelado — nada foi alterado.\n');
    await pool.end();
    return;
  }

  const r = await executarRetencao(pool, { dryRun: false, anos });
  console.log(`\n${C.g}${C.b}Concluído: ${r.devedores} devedor(es), ${r.alunos} aluno(s), ${r.snapshots} snapshot(s).${C.x}`);
  console.log(`${C.d}Registrado em auditoria_exclusoes.${C.x}\n`);
  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
