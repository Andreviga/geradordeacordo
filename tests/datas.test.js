// tests/datas.test.js — Fase D / P1.5: aritmética de datas e ordem
//
// Cópia das funções puras de index.html — manter sincronizadas.
// Execute: node tests/datas.test.js

'use strict';

// ── Cópias de index.html ──────────────────────────────────────────────────
function addMonths(d, m) {
  const dt = new Date(d.getFullYear(), d.getMonth(), 1);
  const day = d.getDate();
  dt.setMonth(dt.getMonth() + m);
  const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  dt.setDate(Math.min(day, last));
  return dt;
}

const parseDate = s => {
  if (!s) return null;
  const p = s.split('-');
  return new Date(+p[0], +p[1]-1, +p[2]);
};

const fmtDate = d => d
  ? String(d.getDate()).padStart(2,'0') + '/'
    + String(d.getMonth()+1).padStart(2,'0') + '/'
    + d.getFullYear()
  : '';

// ── Utilidades ────────────────────────────────────────────────────────────
let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else       { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

// ── [1] addMonths — dia 29/30/31 em meses curtos ───────────────────────
grupo('[1] addMonths — dia no fim do mês ajustado ao último dia do mês destino');
{
  // 31/01 + 1 mês = 28/02 (fevereiro sem bissexto)
  const jan31 = new Date(2025, 0, 31);
  const fev = addMonths(jan31, 1);
  assert('31/01 + 1 mês = 28/02 (fev 2025 tem 28 dias)', fev.getDate()===28 && fev.getMonth()===1 && fev.getFullYear()===2025);

  // 31/01 + 1 mês em ano bissexto = 29/02
  const jan31_2024 = new Date(2024, 0, 31);
  const fev_2024 = addMonths(jan31_2024, 1);
  assert('31/01/2024 + 1 mês = 29/02/2024 (bissexto)', fev_2024.getDate()===29 && fev_2024.getMonth()===1 && fev_2024.getFullYear()===2024);

  // 30/01 + 1 mês = 28/02 (fev 2025)
  const jan30 = new Date(2025, 0, 30);
  const fev30 = addMonths(jan30, 1);
  assert('30/01 + 1 mês = 28/02 (fev 2025)', fev30.getDate()===28 && fev30.getMonth()===1);

  // 29/01 + 1 mês = 28/02 (fev 2025, não bissexto)
  const jan29 = new Date(2025, 0, 29);
  const fev29 = addMonths(jan29, 1);
  assert('29/01 + 1 mês = 28/02 (fev 2025)', fev29.getDate()===28 && fev29.getMonth()===1);

  // 31/03 + 1 mês = 30/04
  const mar31 = new Date(2025, 2, 31);
  const abr = addMonths(mar31, 1);
  assert('31/03 + 1 mês = 30/04 (abril tem 30 dias)', abr.getDate()===30 && abr.getMonth()===3);

  // 28/02 + 1 mês = 28/03 (mês completo)
  const fev28 = new Date(2025, 1, 28);
  const mar = addMonths(fev28, 1);
  assert('28/02 + 1 mês = 28/03 (dia mantido)', mar.getDate()===28 && mar.getMonth()===2);
}

// ── [2] addMonths — múltiplos meses ───────────────────────────────────────
grupo('[2] addMonths — múltiplos meses');
{
  // 31/01 + 12 meses = 31/01 do ano seguinte
  const jan31 = new Date(2025, 0, 31);
  const jan31_2026 = addMonths(jan31, 12);
  assert('31/01 + 12 meses = 31/01/2026', jan31_2026.getDate()===31 && jan31_2026.getMonth()===0 && jan31_2026.getFullYear()===2026);

  // 31/12 + 1 mês = 31/01
  const dez31 = new Date(2025, 11, 31);
  const jan31_next = addMonths(dez31, 1);
  assert('31/12 + 1 mês = 31/01/2026', jan31_next.getDate()===31 && jan31_next.getMonth()===0 && jan31_next.getFullYear()===2026);
}

// ── [3] Validação de ordem das datas ──────────────────────────────────────
grupo('[3] Validação de ordem das datas (P1.5)');
{
  // Simula a lógica de validarExportacao para datas
  function validarOrdemDatas(assinatura, entradaData, parcelaData, temEntrada) {
    const erros = [], avisos = [];
    const dAssin = assinatura ? parseDate(assinatura) : null;
    const dEntr  = (temEntrada && entradaData) ? parseDate(entradaData) : null;
    const dParc  = parcelaData ? parseDate(parcelaData) : null;

    if (temEntrada && !dEntr)
      avisos.push('sem data de entrada');
    if (dParc) {
      if (dEntr && dEntr > dParc)
        erros.push('entrada posterior à parcela');
      if (dAssin && dEntr && dAssin > dEntr)
        avisos.push('assinatura posterior à entrada');
      else if (dAssin && !dEntr && dAssin > dParc)
        avisos.push('assinatura posterior à parcela');
    }
    return { erros, avisos };
  }

  // OK: assinatura < entrada < parcela
  const r1 = validarOrdemDatas('2025-01-01', '2025-01-15', '2025-02-01', true);
  assert('OK: assin < entrada < parcela → sem erros', r1.erros.length===0 && r1.avisos.length===0);

  // ERRO: entrada após parcela
  const r2 = validarOrdemDatas(null, '2025-03-01', '2025-02-01', true);
  assert('ERRO: entrada (01/03) > parcela (01/02)', r2.erros.length===1);

  // AVISO: assinatura após entrada
  const r3 = validarOrdemDatas('2025-02-01', '2025-01-01', '2025-03-01', true);
  assert('AVISO: assinatura (01/02) > entrada (01/01)', r3.avisos.length===1 && r3.erros.length===0);

  // AVISO: assinatura após 1ª parcela (sem entrada)
  const r4 = validarOrdemDatas('2025-03-01', null, '2025-02-01', false);
  assert('AVISO: assinatura (01/03) > parcela (01/02), sem entrada', r4.avisos.length===1);

  // OK: sem assinatura (op_datavazia) — não valida
  const r5 = validarOrdemDatas(null, '2025-01-15', '2025-02-01', true);
  assert('OK: sem data de assinatura → sem erros', r5.erros.length===0 && r5.avisos.length===0);

  // AVISO: tem entrada sem data
  const r6 = validarOrdemDatas(null, null, '2025-02-01', true);
  assert('AVISO: tem entrada mas sem data de vencimento', r6.avisos.length>=1);

  // OK: datas iguais (assin = entrada = parcela)
  const r7 = validarOrdemDatas('2025-01-15', '2025-01-15', '2025-01-15', true);
  assert('OK: datas iguais — sem erros', r7.erros.length===0 && r7.avisos.length===0);
}

// ── Resultado ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
console.log(`Resultado: ${passou} ✓  ${falhou} ✗\n`);
if (falhou > 0) process.exit(1);
