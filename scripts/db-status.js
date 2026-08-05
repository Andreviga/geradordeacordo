#!/usr/bin/env node
'use strict';
// scripts/db-status.js — verifica o schema sem alterar dados em produção
// Uso: npm run db:status
// Os checks comportamentais INSERT em BEGIN/ROLLBACK — nada é commitado.

const { loadEnv, criarCliente, conectar, criarColeta, runEstruturais, runComportamentais } = require('./db-utils');

async function main() {
  loadEnv();

  let client;
  try { client = criarCliente(); }
  catch (err) { sair(err.message); }

  console.log('\ndb:status — verificação completa (somente leitura)\n' + '─'.repeat(50));
  console.log('  Checks comportamentais usam BEGIN/ROLLBACK — nenhum dado é commitado.\n');

  try { await conectar(client); }
  catch (err) { sair(err.message); }

  const R = criarColeta();
  try {
    const tabelasFaltando = await runEstruturais(client, R);
    if (tabelasFaltando > 0) {
      process.stdout.write('\n  ⚠  Tabelas ausentes — checks comportamentais ignorados.\n');
      process.stdout.write('     Execute npm run db:migrate para criar o schema.\n');
    } else {
      process.stdout.write('\n');
      await runComportamentais(client, R);
    }
  } catch (err) {
    await client.end();
    sair(`Erro durante verificação: ${err.message}`);
  }

  await client.end();

  if (R.total === 0) {
    console.log('\n\x1b[32mSchema íntegro — estrutura e comportamento verificados.\x1b[0m\n');
    process.exit(0);
  } else {
    console.error(`\n\x1b[31mERRO: ${R.total} problema(s) encontrado(s). Veja acima.\x1b[0m`);
    console.error(`Execute npm run db:migrate para corrigir.\n`);
    process.exit(1);
  }
}

function sair(msg) {
  console.error(`\n\x1b[31mERRO:\x1b[0m ${msg}\n`);
  process.exit(1);
}

main().catch(err => sair(`Erro inesperado: ${err.message}`));
