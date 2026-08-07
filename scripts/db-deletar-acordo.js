#!/usr/bin/env node
'use strict';
// scripts/db-deletar-acordo.js — remove permanentemente um acordo e todos os seus dados.
// Uso: node scripts/db-deletar-acordo.js 2026/001
//
// Recusa se o acordo tiver zapsign_token (documento assinado — use cancelar).
// Registra em auditoria_exclusoes antes de deletar.
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

  // Mostrar o banco-alvo antes de qualquer confirmação — como db:migrate faz
  let bancoLabel = '?';
  try { const u = new URL(process.env.DATABASE_URL || ''); bancoLabel = `${u.hostname}${u.pathname}`; } catch {}
  console.log(`\nBanco-alvo: \x1b[1m${bancoLabel}\x1b[0m`);

  // Buscar o acordo com todos os dados relevantes
  const { rows } = await pool.query(
    `SELECT a.id, a.numero, a.cancelado, a.zapsign_token, a.drive_file_id,
            COUNT(p.id) AS n_parcelas,
            MIN(p.vencimento::date) AS primeira_parcela,
            MAX(p.vencimento::date) AS ultima_parcela,
            (SELECT string_agg(d.nome, ', ')
               FROM acordo_devedores ad JOIN devedores d ON d.id = ad.devedor_id
              WHERE ad.acordo_id = a.id) AS devedores
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

  // Recusar se houver documento de assinatura associado
  if (ac.zapsign_token || ac.drive_file_id) {
    console.error(`\n⛔  Acordo ${ac.numero} não pode ser excluído:`);
    if (ac.zapsign_token)  console.error('   • Tem token ZapSign — documento já enviado para assinatura.');
    if (ac.drive_file_id)  console.error('   • Tem arquivo no Google Drive.');
    console.error('\n   Use o sistema para cancelar o acordo em vez de excluí-lo.\n');
    process.exit(1);
  }

  console.log(`\nAcordo a ser APAGADO PERMANENTEMENTE:`);
  console.log(`  Número   : ${ac.numero}`);
  console.log(`  Devedores: ${ac.devedores}`);
  console.log(`  Parcelas : ${ac.n_parcelas} (${ac.primeira_parcela} → ${ac.ultima_parcela})`);
  console.log(`  Cancelado: ${ac.cancelado ? 'sim' : 'não'}`);
  console.log(`\n⚠  Esta operação é irreversível. Todos os registros vinculados serão removidos.\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const conf = await new Promise(resolve => rl.question(`Digite o número do acordo para confirmar (${ac.numero}): `, resolve));
  rl.close();

  if (conf.trim() !== ac.numero) {
    console.log('\nCancelado — número não confirmado.\n');
    process.exit(0);
  }

  // Registrar em auditoria_exclusoes antes de deletar
  await pool.query(
    `INSERT INTO auditoria_exclusoes (tabela, registro_id, motivo)
     VALUES ('acordos', $1, $2)`,
    [ac.id, `Exclusão manual via db:deletar-acordo por operador (acordo ${ac.numero}, ${ac.n_parcelas} parcelas)`]
  );

  // Deleta o acordo — CASCADE no schema remove parcelas e vínculos
  await pool.query('DELETE FROM acordos WHERE id = $1', [ac.id]);
  console.log(`\n\x1b[32m✓ Acordo ${ac.numero} removido com sucesso. Registro em auditoria_exclusoes criado.\x1b[0m\n`);
  await pool.end();
}

main().catch(err => { console.error('\nErro:', err.message); process.exit(1); });
