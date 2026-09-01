#!/usr/bin/env node
'use strict';
// scripts/db-restore.js — restaura um backup gerado por api/cron/_backup_engine.js
//
//   npm run db:restore -- <arquivo.json.gz|.json> [opções]
//
// Opções:
//   --dry-run          faz tudo (inclusive os INSERTs) e dá ROLLBACK no fim.
//                      É o ensaio real: valida constraints sem persistir nada.
//   --sim              pula a confirmação digitada (para automação).
//   --tabela=<nome>    restaura só uma tabela. Repetível.
//
// Por que este script existe: o procedimento antigo era um `node -e` de 40 linhas
// colado do README. Ele usava `SET CONSTRAINTS ALL DEFERRED`, que não tem efeito
// aqui — nenhuma FK do schema é DEFERRABLE — e inseria linha a linha, sem
// verificação no fim. Aqui o TRUNCATE é único e em CASCADE, os INSERTs vão em
// lote, tudo dentro de uma transação, e as contagens são conferidas antes do
// COMMIT: se divergirem, o restore se desfaz sozinho.

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m' };
const ok    = m => console.log(`  ${C.g}✓${C.x} ${m}`);
const aviso = m => console.log(`  ${C.y}⚠${C.x}  ${m}`);
const erro  = m => console.error(`  ${C.r}✗${C.x} ${m}`);

function uso(msg) {
  if (msg) erro(msg);
  console.error(`
${C.b}Uso:${C.x} npm run db:restore -- <arquivo.json.gz> [--dry-run] [--sim] [--tabela=nome]

  --dry-run        ensaio completo com ROLLBACK no fim (nada e gravado)
  --sim            pula a confirmacao digitada
  --tabela=nome    restaura so essa tabela (repetivel)
`);
  process.exit(1);
}

// ── Leitura do dump ───────────────────────────────────────────────────────────
function lerDump(caminho) {
  if (!fs.existsSync(caminho)) uso(`Arquivo nao encontrado: ${caminho}`);
  const bruto = fs.readFileSync(caminho);
  // Detecta gzip pelos bytes magicos, nao pela extensao
  const ehGzip = bruto.length > 2 && bruto[0] === 0x1f && bruto[1] === 0x8b;
  let texto;
  try {
    texto = (ehGzip ? zlib.gunzipSync(bruto) : bruto).toString('utf8');
  } catch (e) {
    uso(`Nao consegui descomprimir "${path.basename(caminho)}": ${e.message}`);
  }
  let dump;
  try { dump = JSON.parse(texto); } catch (e) { uso(`JSON invalido: ${e.message}`); }
  if (!dump || typeof dump.dados !== 'object' || dump.dados === null)
    uso('Estrutura inesperada: falta a chave "dados". Este arquivo e um backup deste sistema?');
  return { dump, ehGzip, bytes: bruto.length };
}

// Postgres aceita no maximo 65535 parametros por comando — daí o lote por colunas
function chunk(linhas, porLote) {
  const out = [];
  for (let i = 0; i < linhas.length; i += porLote) out.push(linhas.slice(i, i + porLote));
  return out;
}

async function inserirTabela(client, tabela, linhas) {
  if (!linhas.length) return 0;
  const cols  = Object.keys(linhas[0]);
  const ident = cols.map(c => `"${c}"`).join(',');
  const porLote = Math.max(1, Math.floor(60000 / cols.length));
  let gravadas = 0;
  for (const lote of chunk(linhas, porLote)) {
    const params = [];
    const tuplas = lote.map(linha => {
      const marcas = cols.map(c => {
        params.push(linha[c] === undefined ? null : linha[c]);
        return `$${params.length}`;
      });
      return `(${marcas.join(',')})`;
    });
    await client.query(`INSERT INTO "${tabela}" (${ident}) VALUES ${tuplas.join(',')}`, params);
    gravadas += lote.length;
  }
  return gravadas;
}

async function colunasDoBanco(client, tabela) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`, [tabela]
  );
  return new Set(rows.map(r => r.column_name));
}

function perguntar(texto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(texto, r => { rl.close(); res(r.trim()); }));
}

// ── Principal ─────────────────────────────────────────────────────────────────
async function main() {
  require('./db-utils').loadEnv();
  const { getPool } = require('../api/_db');
  const { TABELAS } = require('../api/cron/_backup_engine');

  const argv      = process.argv.slice(2);
  const arquivo   = argv.find(a => !a.startsWith('--'));
  const dryRun    = argv.includes('--dry-run');
  const semPerg   = argv.includes('--sim');
  const soTabelas = argv.filter(a => a.startsWith('--tabela=')).map(a => a.slice(9));

  if (!arquivo) uso('Informe o arquivo de backup.');

  const { dump, ehGzip, bytes } = lerDump(arquivo);
  const geradoEm = dump._meta && dump._meta.gerado_em;

  console.log(`\n${C.b}db:restore${C.x}`);
  console.log('─'.repeat(62));
  console.log(`  Arquivo : ${path.basename(arquivo)} (${(bytes / 1024).toFixed(1)} KB${ehGzip ? ', gzip' : ''})`);
  console.log(`  Gerado  : ${geradoEm ? new Date(geradoEm).toLocaleString('pt-BR') : C.y + 'sem _meta.gerado_em' + C.x}`);

  // Ordem de restauracao: a do engine (pai antes de filho), filtrada pelo dump
  let ordem = TABELAS.filter(t => Array.isArray(dump.dados[t]));
  const extras   = Object.keys(dump.dados).filter(t => !TABELAS.includes(t));
  const faltando = TABELAS.filter(t => !Array.isArray(dump.dados[t]));
  if (extras.length)   aviso(`Tabelas no dump que o sistema nao conhece (ignoradas): ${extras.join(', ')}`);
  if (faltando.length) aviso(`Tabelas ausentes no dump: ${faltando.join(', ')}`);

  if (soTabelas.length) {
    const desconhecida = soTabelas.find(t => !ordem.includes(t));
    if (desconhecida) uso(`--tabela=${desconhecida} nao existe no dump.`);
    ordem = ordem.filter(t => soTabelas.includes(t));
    aviso(`Restauracao parcial: ${ordem.join(', ')}`);
    aviso('TRUNCATE ... CASCADE pode apagar linhas de tabelas filhas que NAO serao repostas.');
  }
  if (!ordem.length) uso('Nada a restaurar.');

  const pool = getPool();
  if (!pool) uso('DATABASE_URL nao configurado. Defina em .env.local.');
  let host = '(desconhecido)';
  try { host = new URL(process.env.DATABASE_URL).hostname; } catch { /* ignore */ }

  const client = await pool.connect();
  try {
    // Conferencia de schema ANTES de qualquer escrita
    console.log(`\n${C.b}Conferindo o banco alvo${C.x}`);
    console.log(`  Host: ${C.b}${host}${C.x}`);
    let problemas = 0;
    const resumo = [];
    for (const t of ordem) {
      const doBanco = await colunasDoBanco(client, t);
      if (!doBanco.size) { erro(`tabela "${t}" nao existe no banco alvo — rode npm run db:migrate`); problemas++; continue; }
      const linhas   = dump.dados[t];
      const doDump   = linhas.length ? Object.keys(linhas[0]) : [];
      const ausentes = doDump.filter(c => !doBanco.has(c));
      if (ausentes.length) { erro(`"${t}": colunas no dump que nao existem no banco: ${ausentes.join(', ')}`); problemas++; }
      const { rows } = await client.query(`SELECT COUNT(*)::int n FROM "${t}"`);
      resumo.push({ tabela: t, hoje: rows[0].n, dump: linhas.length });
    }
    if (problemas) {
      console.error(`\n${C.r}Schema incompativel — nada foi alterado.${C.x}\n`);
      process.exitCode = 1;
      return;
    }
    ok('todas as tabelas existem e as colunas batem');

    console.log(`\n${C.b}O que vai acontecer${C.x}`);
    console.log(`  ${'tabela'.padEnd(22)} ${'hoje'.padStart(7)} → ${'do backup'.padStart(9)}`);
    for (const r of resumo) {
      const cor = r.hoje === r.dump ? C.d : (r.hoje > r.dump ? C.y : C.g);
      console.log(`  ${cor}${r.tabela.padEnd(22)} ${String(r.hoje).padStart(7)} → ${String(r.dump).padStart(9)}${C.x}`);
    }
    const totalHoje = resumo.reduce((s, r) => s + r.hoje, 0);
    const totalDump = resumo.reduce((s, r) => s + r.dump, 0);
    console.log(`  ${C.b}${'TOTAL'.padEnd(22)} ${String(totalHoje).padStart(7)} → ${String(totalDump).padStart(9)}${C.x}`);

    if (dryRun) {
      aviso('--dry-run: os INSERTs rodam de verdade e no fim tudo e desfeito (ROLLBACK).');
    } else {
      console.log(`\n${C.r}${C.b}  Isto APAGA os dados atuais das tabelas acima e poe os do backup no lugar.${C.x}`);
      if (!semPerg) {
        const resp = await perguntar(`\n  Para confirmar, digite o host do banco (${host}): `);
        if (resp !== host) { console.log('\n  Cancelado — nada foi alterado.\n'); return; }
      }
    }

    // ── Transacao ───────────────────────────────────────────────────────────
    console.log(`\n${C.b}Restaurando${C.x}`);
    const t0 = Date.now();
    await client.query('BEGIN');
    // TRUNCATE unico resolve dependencias circulares de uma vez, ao contrario de
    // truncar tabela a tabela dentro do laco (que so funciona pela ordem certa).
    await client.query(`TRUNCATE ${ordem.map(t => `"${t}"`).join(', ')} CASCADE`);
    ok(`TRUNCATE em ${ordem.length} tabela(s)`);

    for (const t of ordem) {
      const n = await inserirTabela(client, t, dump.dados[t]);
      console.log(`  ${C.d}·${C.x} ${t.padEnd(22)} ${String(n).padStart(7)} linha(s)`);
    }

    // Conferencia DENTRO da transacao, antes de decidir COMMIT
    let divergencia = 0;
    for (const r of resumo) {
      const { rows } = await client.query(`SELECT COUNT(*)::int n FROM "${r.tabela}"`);
      if (rows[0].n !== r.dump) { erro(`"${r.tabela}": esperado ${r.dump}, encontrado ${rows[0].n}`); divergencia++; }
    }
    if (divergencia) {
      await client.query('ROLLBACK');
      console.error(`\n${C.r}Contagens divergentes — ROLLBACK. Banco intacto.${C.x}\n`);
      process.exitCode = 1;
      return;
    }
    ok('contagens conferem com o backup');

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log(`\n${C.g}${C.b}Ensaio concluido em ${((Date.now() - t0) / 1000).toFixed(1)}s — ROLLBACK dado, banco intacto.${C.x}`);
      console.log(`${C.d}Rode sem --dry-run para valer.${C.x}\n`);
    } else {
      await client.query('COMMIT');
      console.log(`\n${C.g}${C.b}Restore concluido em ${((Date.now() - t0) / 1000).toFixed(1)}s — ${totalDump} linha(s).${C.x}`);
      console.log(`${C.d}Confira com: npm run db:status${C.x}\n`);
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error(`\n${C.r}Falhou: ${e.message}${C.x}`);
    console.error(`${C.d}ROLLBACK dado — o banco nao foi alterado.${C.x}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { lerDump, inserirTabela, chunk, colunasDoBanco };
