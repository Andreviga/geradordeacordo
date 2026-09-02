#!/usr/bin/env node
'use strict';
// scripts/backup-baixar.js — backup sob demanda, gravado aqui na máquina.
//
//   npm run backup:baixar                    → ./backups/backup-manual-<data>.json.gz
//   npm run backup:baixar -- --dir=D:/copias → grava em outra pasta
//   npm run backup:baixar -- --cifrar        → cifra com BACKUP_SENHA (ou --senha=)
//
// Para que serve: o cron semanal manda o arquivo para fora (Drive ou e-mail).
// Este comando é o contrário — traz uma cópia para perto, sob controle de quem
// roda, sem passar por terceiro nenhum. É o que se roda antes de uma operação de
// risco: migração de schema, expurgo de retenção, restore.
//
// O arquivo sai no mesmo formato do cron, então o npm run db:restore lê os dois.

const fs   = require('fs');
const path = require('path');

require('./db-utils').loadEnv();
const { getPool }     = require('../api/_db');
const { montarDump }  = require('../api/cron/_backup_engine');

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m' };

async function main() {
  const argv     = process.argv.slice(2);
  const argDir   = argv.find(a => a.startsWith('--dir='));
  const argSenha = argv.find(a => a.startsWith('--senha='));
  const cifrar   = argv.includes('--cifrar') || !!argSenha;
  const senha    = argSenha ? argSenha.slice(8) : process.env.BACKUP_SENHA;
  const destino  = argDir ? argDir.slice(6) : path.join(process.cwd(), 'backups');

  if (cifrar && !senha) {
    console.error(`${C.r}--cifrar precisa de uma senha: use --senha=... ou defina BACKUP_SENHA.${C.x}`);
    process.exit(1);
  }

  const pool = getPool();
  if (!pool) { console.error('DATABASE_URL não configurado.'); process.exit(1); }

  let host = '(desconhecido)';
  try { host = new URL(process.env.DATABASE_URL).hostname; } catch { /* ignore */ }

  console.log(`\n${C.b}Backup manual${C.x}`);
  console.log('─'.repeat(62));
  console.log(`  Banco : ${host}`);

  const t0 = Date.now();
  const { dump, bufGzip, totalLinhas } = await montarDump(pool);
  await pool.end();

  let conteudo = bufGzip;
  let nome = `backup-manual-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json.gz`;
  if (cifrar) {
    conteudo = require('../api/cron/_backup_cripto').cifrar(bufGzip, senha);
    nome += '.enc';
  }

  fs.mkdirSync(destino, { recursive: true });
  const caminho = path.join(destino, nome);
  fs.writeFileSync(caminho, conteudo);

  const linhasPorTabela = Object.entries(dump.dados)
    .filter(([, r]) => r.length)
    .map(([t, r]) => `${t}=${r.length}`)
    .join('  ');

  console.log(`  Linhas: ${totalLinhas}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (linhasPorTabela) console.log(`  ${C.d}${linhasPorTabela}${C.x}`);
  console.log(`\n${C.g}${C.b}Gravado: ${caminho}${C.x}`);
  console.log(`  ${(conteudo.length / 1024).toFixed(1)} KB${cifrar ? ', cifrado' : ''}`);
  if (cifrar) console.log(`  ${C.y}Sem a senha este arquivo não é recuperável.${C.x}`);
  else console.log(`  ${C.y}Não está cifrado: contém CPF, endereços e dados de menores. Guarde com cuidado.${C.x}`);
  console.log(`\n${C.d}Para restaurar: npm run db:restore -- "${caminho}"${cifrar ? ' --senha=...' : ''}${C.x}\n`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
