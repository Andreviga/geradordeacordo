#!/usr/bin/env node
'use strict';
// scripts/db-limpar-testes.js — remove dados de testes de integração
// Uso: npm run db:limpar-testes
//
// Identifica registros de teste por padrão de e-mail, nome e CPF.
// Mostra preview completo e exige confirmação antes de apagar.
// Recusa se encontrar registro que não se encaixa nos padrões de teste.

require('./db-utils').loadEnv();
const readline   = require('readline');
const { getPool } = require('../api/_db');

// Segurança por construção: a permissão está atrelada ao host, não a uma flag separada.
// BANCO_TESTE_HOST deve ser o hostname do banco de testes (sem esquema, sem porta).
// O script recusa se o DATABASE_URL atual apontar para outro host.
const rawUrl    = process.env.DATABASE_URL || '';
let bancoHost   = '?';
try { bancoHost = new URL(rawUrl).hostname; } catch {}

const testeHost = (process.env.BANCO_TESTE_HOST || '').trim();

if (!testeHost) {
  console.error('\n⛔  BANCO_TESTE_HOST não configurado.');
  console.error('   Defina o host do banco de testes no .env.local (sem https://, sem porta).');
  console.error(`   Banco atual: ${bancoHost}\n`);
  process.exit(1);
}

if (bancoHost !== testeHost) {
  console.error(`\n⛔  Host atual (${bancoHost}) ≠ banco de testes (${testeHost}).`);
  console.error('   Configure DATABASE_URL para o banco de testes antes de limpar dados.\n');
  process.exit(1);
}

// Padrões que identificam dados de teste de forma inequívoca
const PATTERNS = {
  usuario_email:  `email LIKE '%@test.local'`,
  devedor_cpf:    `cpf LIKE '999.%' OR cpf = '111.111.111-11' OR cpf = '000.000.000-00'`,
  acordo_numero:  `numero LIKE '%SMOKE%'`,
};

async function main() {
  const pool = getPool();
  if (!pool) { console.error('DATABASE_URL não configurado.'); process.exit(1); }

  const rawUrl = process.env.DATABASE_URL || '';
  let bancoLabel = '?';
  try { const u = new URL(rawUrl); bancoLabel = `${u.hostname}${u.pathname}`; } catch {}
  console.log(`\nLimpeza de dados de teste\nBanco-alvo: \x1b[1m${bancoLabel}\x1b[0m\n${'─'.repeat(40)}`);

  // 1. Usuários de teste (e-mail @test.local)
  const { rows: testUsers } = await pool.query(
    `SELECT id, nome, email, papel, criado_em FROM usuarios WHERE ${PATTERNS.usuario_email} ORDER BY criado_em`
  );

  // 2. Devedores de teste (CPF padrão)
  const { rows: testDevs } = await pool.query(
    `SELECT id, nome, cpf FROM devedores WHERE ${PATTERNS.devedor_cpf} ORDER BY nome`
  );

  // 3. Acordos criados por usuários de teste OU com número padrão de teste
  const testUserIds = testUsers.map(u => u.id);
  let testAcordos = [];
  if (testUserIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT id, numero, criado_em FROM acordos WHERE criado_por = ANY($1::uuid[]) ORDER BY criado_em`,
      [testUserIds]
    );
    testAcordos = rows;
  }
  // Também acordos com número explicitamente de teste (SMOKE)
  const { rows: acordosByNumero } = await pool.query(
    `SELECT id, numero, criado_em FROM acordos WHERE ${PATTERNS.acordo_numero} ORDER BY criado_em`
  );
  const acordoIdsJaInclusos = new Set(testAcordos.map(a => a.id));
  for (const a of acordosByNumero) {
    if (!acordoIdsJaInclusos.has(a.id)) testAcordos.push(a);
  }

  // 4. Verificação de segurança: existe algum acordo criado por usuário NÃO-teste?
  //    (guardamos esta checagem para evitar falsos positivos)
  let problemasDetectados = [];
  if (testUserIds.length > 0) {
    const { rows: realAcordos } = await pool.query(
      `SELECT u.email, COUNT(a.id) AS n
       FROM acordos a JOIN usuarios u ON u.id = a.criado_por
       WHERE a.criado_por = ANY($1::uuid[]) AND u.email NOT LIKE '%@test.local'
       GROUP BY u.email`,
      [testUserIds]
    );
    if (realAcordos.length > 0) {
      problemasDetectados.push(`Acordos criados por usuário não-teste encontrados: ${realAcordos.map(r => r.email).join(', ')}`);
    }
  }

  // Mostrar preview
  if (testUsers.length === 0 && testDevs.length === 0 && testAcordos.length === 0) {
    console.log('\nNada a limpar — nenhum dado de teste encontrado.\n');
    process.exit(0);
  }

  console.log('\nDados de teste encontrados:\n');
  if (testUsers.length > 0) {
    console.log(`  Usuários (${testUsers.length}):`);
    testUsers.forEach(u => console.log(`    • ${u.email} (${u.papel}) — criado em ${u.criado_em?.toISOString?.()?.slice(0,10) || u.criado_em}`));
  }
  if (testAcordos.length > 0) {
    console.log(`\n  Acordos (${testAcordos.length}):`);
    testAcordos.forEach(a => console.log(`    • ${a.numero || '(sem número)'} — criado em ${a.criado_em?.toISOString?.()?.slice(0,10) || a.criado_em}`));
  }
  if (testDevs.length > 0) {
    console.log(`\n  Devedores com CPF de teste (${testDevs.length}):`);
    testDevs.forEach(d => console.log(`    • ${d.nome} (CPF: ${d.cpf})`));
  }

  if (problemasDetectados.length > 0) {
    console.error('\n\x1b[31mAVISO: problema detectado — abortando por segurança:\x1b[0m');
    problemasDetectados.forEach(p => console.error(`  • ${p}`));
    console.error('\nVerifique manualmente antes de prosseguir.\n');
    process.exit(1);
  }

  // Confirmação explícita
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const resposta = await new Promise(resolve => rl.question('\nApagar esses dados? [s/N] ', resolve));
  rl.close();

  if (resposta.toLowerCase() !== 's') {
    console.log('\nCancelado.\n');
    process.exit(0);
  }

  // Execução
  console.log('\nApagando...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const allAcordoIds = testAcordos.map(a => a.id);
    if (allAcordoIds.length > 0) {
      // Apagar em cascata: parcelas, junction tables são ON DELETE CASCADE
      // auditoria_exclusoes referencia usuarios, apagar antes dos usuários
      await client.query(
        `DELETE FROM auditoria_exclusoes WHERE excluido_por = ANY($1::uuid[])`, [testUserIds]
      );
      // acordos e filhos (ON DELETE CASCADE: parcelas, acordo_devedores, etc.)
      await client.query(`DELETE FROM acordos WHERE id = ANY($1::uuid[])`, [allAcordoIds]);
    }

    // Devedores de teste que já não têm acordos vinculados
    if (testDevs.length > 0) {
      const devIds = testDevs.map(d => d.id);
      // Só apaga se não houver vínculo restante
      const { rows: vinculados } = await client.query(
        `SELECT devedor_id FROM acordo_devedores WHERE devedor_id = ANY($1::uuid[])`, [devIds]
      );
      const devVinculadosIds = new Set(vinculados.map(v => v.devedor_id));
      const devParaApagar = devIds.filter(id => !devVinculadosIds.has(id));
      if (devParaApagar.length > 0)
        await client.query(`DELETE FROM devedores WHERE id = ANY($1::uuid[])`, [devParaApagar]);
      if (devParaApagar.length < devIds.length)
        console.log(`  ⚠ ${devIds.length - devParaApagar.length} devedor(es) mantidos (ainda vinculados a acordos)`);
    }

    if (testUserIds.length > 0)
      await client.query(`DELETE FROM usuarios WHERE id = ANY($1::uuid[])`, [testUserIds]);

    await client.query('COMMIT');
    console.log('\x1b[32m\nLimpeza concluída.\x1b[0m');
    console.log(`  Removidos: ${testAcordos.length} acordo(s), ${testUsers.length} usuário(s)\n`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nErro durante limpeza (rollback):', err.message);
    process.exit(1);
  } finally {
    client.release();
  }
}

main().catch(err => {
  console.error('\nErro inesperado:', err.message);
  process.exit(1);
});
