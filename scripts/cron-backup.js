#!/usr/bin/env node
'use strict';
// scripts/cron-backup.js — dispara o backup manualmente para teste ou emergência.
// Uso: npm run cron:backup
require('./db-utils').loadEnv();
const { getPool } = require('../api/_db');
const { executarBackup } = require('../api/cron/_backup_engine');

async function main() {
  const pool = getPool();
  if (!pool) { console.error('DATABASE_URL não configurado.'); process.exit(1); }
  console.log('\nIniciando backup manual...\n');
  const r = await executarBackup(pool);
  console.log(`\n✓ Backup concluído: ${r.totalLinhas} linhas exportadas`);
  r.uploads.forEach(u => console.log(`  [${u.tipo}] ${u.nome} — ${u.tamanho} bytes`));
  console.log('');
}

main().catch(err => { console.error('\nErro:', err.message); process.exit(1); });
