#!/usr/bin/env node
'use strict';
// scripts/db-deletar-acordo.js — remove permanentemente um acordo e todos os seus dados.
// Uso: node scripts/db-deletar-acordo.js 2026/001
//
// Funciona em QUALQUER banco (produção inclusive), portanto exige confirmação explícita.
// Deleta em cascata: parcelas, lembretes_enviados, acordo_devedores, acordo_credoras, acordo_alunos.

require('./db-utils').loadEnv();
const readline = require('readline');
const { getPool } = require('../api/_db');

async function main() {
  const numero = (process.argv[2] || '').trim();
  if (!numero) {
    console.error('\nUso: node scripts/db-deletar-acordo.js NUMERO\nExemplo: node scripts/db-deletar-acordo.js 2026/001\n');
    process.exit(1);
  }

  const pool = getPool();
  if (!pool) { console.error('DATABASE_URL não configurado.'); process.exit(1); }

  let bancoLabel = '?';
  try { const u = new URL(process.env.DATABASE_URL || ''); bancoLabel = `${u.hostname}${u.pathname}`; } catch {}

  // Buscar o acordo
  const { rows } = await pool.query(
    `SELECT a.id, a.numero, a.cancelado,
            COUNT(p.id) AS n_parcelas,
            MIN(p.vencimento::date) AS primeira_parcela,
            MAX(p.vencimento::date) AS ultima_parcela,
            (SELECT string_agg(d.nome, ', ') FROM acordo_devedores ad JOIN devedores d ON d.id=ad.devedor_id WHERE ad.acordo_id=a.id) AS devedores
     FROM acordos a
     LEFT JOIN parcelas p ON p.acordo_id = a.id
     WHERE a.numero = $1
     GROUP BY a.id`, [numero]
  );

  if (!rows.length) {
    console.error(`\n⛔  Acordo "${numero}" não encontrado no banco ${bancoLabel}.\n`);
    process.exit(1);
  }

  const ac = rows[0];
  console.log(`\nBanco-alvo: \x1b[1m${bancoLabel}\x1b[0m\n`);
  console.log(`Acordo a ser APAGADO PERMANENTEMENTE:`);
  console.log(`  Número  : ${ac.numero}`);
  console.log(`  Devedores: ${ac.devedores}`);
  console.log(`  Parcelas: ${ac.n_parcelas} (${ac.primeira_parcela} → ${ac.ultima_parcela})`);
  console.log(`  Cancelado: ${ac.cancelado ? 'sim' : 'não'}`);
  console.log(`\n⚠  Esta operação é irreversível. Todos os registros vinculados serão removidos.\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const conf = await new Promise(resolve => rl.question(`Digite o número do acordo para confirmar (${ac.numero}): `, resolve));
  rl.close();

  if (conf.trim() !== ac.numero) {
    console.log('\nCancelado — número não confirmado.\n');
    process.exit(0);
  }

  // Deleta o acordo; parcelas e vínculos são removidos por CASCADE no schema
  await pool.query('DELETE FROM acordos WHERE id = $1', [ac.id]);
  console.log(`\n\x1b[32m✓ Acordo ${ac.numero} removido com sucesso.\x1b[0m\n`);
  await pool.end();
}

main().catch(err => { console.error('\nErro:', err.message); process.exit(1); });
