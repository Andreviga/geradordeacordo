#!/usr/bin/env node
'use strict';
// scripts/db-migrate.js — aplica db/schema.sql e verifica o resultado
// Uso: npm run db:migrate

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { loadEnv, criarCliente, conectar, criarColeta, runEstruturais, runComportamentais } = require('./db-utils');

function lerHost(url) {
  try { return new URL(url || '').hostname; } catch { return '?'; }
}

async function confirmarSeNaoTesteHost(bancoHost) {
  const testeHost = (process.env.BANCO_TESTE_HOST || '').trim();
  if (!testeHost || bancoHost === testeHost) return; // host conhecido ou não configurado → prosseguir
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const resp = await new Promise(resolve => {
    process.stdout.write(`\n⚠  Você está prestes a migrar: \x1b[1m${bancoHost}\x1b[0m\n`);
    process.stdout.write(`   Este NÃO é o banco de testes configurado (${testeHost}).\n`);
    rl.question('   Confirmar? [s/N] ', resolve);
  });
  rl.close();
  if (resp.toLowerCase() !== 's') { console.log('\nCancelado.\n'); process.exit(0); }
}

async function main() {
  loadEnv();

  const bancoHost = lerHost(process.env.DATABASE_URL);
  await confirmarSeNaoTesteHost(bancoHost);

  let client;
  try { client = criarCliente(); }
  catch (err) { sair(err.message); }

  console.log(`\ndb:migrate — Banco: \x1b[1m${bancoHost}\x1b[0m\n` + '─'.repeat(44));

  try { await conectar(client); }
  catch (err) { sair(err.message); }

  // ── 1. Aplicar schema ────────────────────────────────────────────────────
  process.stdout.write('\n[1/2] Aplicando schema...\n');
  // BEGIN/COMMIT ficam no schema.sql para leitura direta via psql.
  // Aqui controlamos a transação no JS para capturar o erro com precisão.
  const rawSql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  const schemaSql = rawSql
    .replace(/^\s*BEGIN\s*;/im, '')
    .replace(/COMMIT\s*;\s*$/im, '');

  await client.query('BEGIN');
  try {
    await client.query(schemaSql);
    await client.query('COMMIT');
    process.stdout.write('  \x1b[32m✓\x1b[0m Schema aplicado com sucesso\n');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    await client.end();
    // Mapeia códigos PostgreSQL para mensagens acionáveis
    const c = err.code;
    let msg;
    if (c === '42P01') msg = `Referência a objeto inexistente durante aplicação do schema:\n  ${err.message}\n  Dica: verifique a ordem das declarações em db/schema.sql.`;
    else if (c === '42501') msg = `Sem permissão para criar objetos no banco:\n  ${err.message}\n  Dica: o usuário da DATABASE_URL precisa de CREATE TABLE no schema public.`;
    else if (c === '42710') msg = `Objeto já existe (não esperado com IF NOT EXISTS):\n  ${err.message}`;
    else if (c === '23505') msg = `Violação de unicidade durante schema:\n  ${err.message}`;
    else msg = `Erro ao aplicar schema (código ${c || 'desconhecido'}): ${err.message}`;
    sair(msg);
  }

  // ── 2. Verificar ─────────────────────────────────────────────────────────
  process.stdout.write('\n[2/2] Verificando...\n');
  const R = criarColeta();
  try {
    const tabelasFaltando = await runEstruturais(client, R);
    if (tabelasFaltando > 0) {
      process.stdout.write(
        '\n  ⚠  Tabelas ausentes — verificação comportamental ignorada.\n'
      );
    } else {
      await runComportamentais(client, R);
    }
  } catch (err) {
    await client.end();
    sair(`Erro durante verificação: ${err.message}`);
  }

  await client.end();
  encerrar(R);
}

function sair(msg) {
  console.error(`\n\x1b[31mERRO:\x1b[0m ${msg}\n`);
  process.exit(1);
}

function encerrar(R) {
  if (R.total === 0) {
    console.log('\n\x1b[32mSchema aplicado e verificado com sucesso.\x1b[0m\n');
    process.exit(0);
  } else {
    console.error(`\n\x1b[31mERRO: ${R.total} verificação(ões) falharam. Veja acima.\x1b[0m\n`);
    process.exit(1);
  }
}

main().catch(err => sair(`Erro inesperado: ${err.message}`));
