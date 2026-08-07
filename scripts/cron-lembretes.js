#!/usr/bin/env node
'use strict';
// scripts/cron-lembretes.js — interface CLI para o motor de lembretes.
//
// Modos:
//   node scripts/cron-lembretes.js --dry-run      Mostra quem receberia o quê, sem enviar nada.
//   node scripts/cron-lembretes.js --test-email   Envia todos os templates para CONTATO_SECRETARIA_EMAIL.
//   node scripts/cron-lembretes.js                Execução real (requer confirmação explícita).
//
// Alias via npm:
//   npm run cron:lembretes -- --dry-run
//   npm run cron:lembretes -- --test-email

const { loadEnv } = require('./db-utils');
loadEnv();

const args    = process.argv.slice(2);
const dryRun  = args.includes('--dry-run');
const testEml = args.includes('--test-email');
const live    = !dryRun && !testEml;

if (live) {
  console.warn('\n⚠  EXECUÇÃO REAL — e-mails serão enviados aos devedores.');
  console.warn('   Use --dry-run para ver a lista sem enviar, ou --test-email para testar.');
  console.warn('   Ctrl+C para cancelar. Iniciando em 5 segundos...\n');
}

const { executarLembretes } = require('../api/cron/_lembretes_engine');

async function main() {
  if (live) {
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  const result = await executarLembretes({ dryRun, testEmail: testEml });

  if (dryRun) {
    console.log('\n=== DRY-RUN — nenhum e-mail enviado ===\n');
    const r = result.resumo;
    console.log('── Parcelas pendentes no banco ──────────────────────');
    console.log(`  Total pendentes (não pagas, não renegociadas): ${r.total_pendentes}`);
    console.log(`  Excluídas: acordo cancelado ..............: ${r.excl_cancelado}`);
    console.log(`  Excluídas: lembretes_ativos = false ......: ${r.excl_sem_lembrete}  ← acordos importados/desativados`);
    console.log(`  Excluídas: sem e-mail (D+1/D+7 faixa) ...: ${r.excl_sem_email_d1_d7}  ← D+15 ainda verifica estas`);
    console.log(`  Excluídas: vencimento muito cedo (>3 dias): ${r.muito_cedo}`);
    console.log(`  Já em tratamento manual ...................: ${r.ja_em_tratamento_manual}`);
    console.log(`\nCap de segurança (LEMBRETES_MAX_POR_EXECUCAO): ${result.cap}`);
    console.log(`\n── E-mails para devedores (${result.paraDevedor.length}) ────────────────────`);
    if (result.paraDevedor.length === 0) {
      console.log('  (nenhum — zero não significa falha; veja o resumo acima)');
    } else {
      result.paraDevedor.forEach(e =>
        console.log(`  [${e.evento}] Acordo ${e.acordo} | ${e.devedor} | ${e.email} | dias: ${e.dias}`)
      );
    }
    console.log(`\n── D+15 — marcação de tratamento manual + aviso interno (${result.paraD15.length}) ──`);
    if (result.paraD15.length === 0) {
      console.log('  (nenhum)');
    } else {
      result.paraD15.forEach(e =>
        console.log(`  Acordo ${e.acordo} | ${e.devedor} | e-mail: ${e.email} | atraso: ${e.dias_atraso} dias | tratamento_manual já ativo: ${e.tratamento_manual}`)
      );
    }
  } else if (testEml) {
    console.log('\n=== TEST-EMAIL — templates enviados para a secretaria ===\n');
    console.log(`Enviados: ${result.enviados}`);
    if (result.erros.length > 0) {
      console.error('Erros:');
      result.erros.forEach(e => console.error(`  ${e.evento} / ${e.acordo}: ${e.erro}`));
    }
  } else {
    console.log(`\n=== EXECUÇÃO CONCLUÍDA ===`);
    console.log(`Enviados: ${result.enviados} / Total candidatos: ${result.total}`);
    if (result.erros.length > 0) {
      console.error(`Erros (${result.erros.length}):`);
      result.erros.forEach(e => console.error(`  [${e.evento}] ${e.acordo}: ${e.erro}`));
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error('\nErro fatal:', err.message);
  process.exit(1);
});
