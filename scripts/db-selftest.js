#!/usr/bin/env node
'use strict';
// scripts/db-selftest.js — valida o mecanismo SAVEPOINT dos checks comportamentais
// Uso: npm run db:selftest
// Não roda em db:status para não executar DDL contra banco de produção na rotina.

const { loadEnv, criarCliente, conectar, criarColeta, runSelfTest } = require('./db-utils');

async function main() {
  loadEnv();

  let client;
  try { client = criarCliente(); }
  catch (err) { sair(err.message); }

  console.log('\ndb:selftest — validação do mecanismo SAVEPOINT\n' + '─'.repeat(46));
  console.log('  Dropa constraint temporariamente e verifica que ROLLBACK a restaura.\n');

  try { await conectar(client); }
  catch (err) { sair(err.message); }

  const R = criarColeta();
  try {
    await runSelfTest(client, R);
  } catch (err) {
    await client.end();
    sair(`Falha crítica no mecanismo de teste: ${err.message}`);
  }

  await client.end();

  if (R.total === 0) {
    console.log('\n\x1b[32mMecanismo SAVEPOINT validado.\x1b[0m\n');
    process.exit(0);
  } else {
    console.error(`\n\x1b[31mERRO: mecanismo de teste com problema — veja acima.\x1b[0m\n`);
    process.exit(1);
  }
}

function sair(msg) {
  console.error(`\n\x1b[31mERRO:\x1b[0m ${msg}\n`);
  process.exit(1);
}

main().catch(err => sair(`Erro inesperado: ${err.message}`));
