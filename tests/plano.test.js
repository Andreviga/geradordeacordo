// Testes unitários de calcPlano()
// Execute com: node tests/plano.test.js
//
// IMPORTANTE: calcPlano() é definida em index.html. Esta cópia deve permanecer
// em sincronia com aquela. Qualquer alteração na lógica deve ser refletida aqui.

'use strict';

// ── Cópia da função pura (sincronizar com index.html) ─────────────────────
function calcPlano(totalCts, entradaCts, modo, qtd, valorParcelaCts) {
  const baseCts = Math.max(0, totalCts - entradaCts);
  let n, parcelaCts, ultimaCts, erro = null;

  if (modo === 'qtd') {
    n = Math.max(1, qtd);
    if (baseCts === 0) {
      parcelaCts = 0; ultimaCts = 0;
    } else {
      parcelaCts = Math.floor(baseCts / n);
      ultimaCts = baseCts - parcelaCts * (n - 1);
    }
  } else {
    if (valorParcelaCts <= 0) {
      erro = 'Valor da parcela deve ser maior que zero.';
      n = 1; parcelaCts = baseCts; ultimaCts = baseCts;
    } else if (valorParcelaCts >= baseCts) {
      n = 1; parcelaCts = baseCts; ultimaCts = baseCts;
    } else {
      n = Math.ceil(baseCts / valorParcelaCts);
      parcelaCts = valorParcelaCts;
      ultimaCts = baseCts - parcelaCts * (n - 1);
      // Resíduo minúsculo (< 10 % da parcela): absorver na última parcela cheia
      if (n > 1 && ultimaCts > 0 && ultimaCts < Math.ceil(parcelaCts / 10)) {
        n -= 1;
        ultimaCts = baseCts - parcelaCts * (n - 1);
      }
    }
  }

  const somaTotal = entradaCts + parcelaCts * (n - 1) + ultimaCts;
  return {
    totalCts, entradaCts, baseCts, n, parcelaCts, ultimaCts,
    iguais: (ultimaCts === parcelaCts),
    aritmOk: (somaTotal === totalCts),
    erro,
  };
}

// ── Utilidades de teste ────────────────────────────────────────────────────
let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else       { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(titulo) { console.log(`\n${titulo}`); }

// ── [1] Caso base: R$ 10.000, sem entrada, 3 parcelas ────────────────────
grupo('[1] R$ 10.000,00, sem entrada, 3 parcelas');
{
  const r = calcPlano(1000000, 0, 'qtd', 3, 0);
  assert('n = 3', r.n === 3);
  assert('parcela = 333.333 cts (R$ 3.333,33)', r.parcelaCts === 333333);
  assert('última = 333.334 cts (R$ 3.333,34)', r.ultimaCts === 333334);
  assert('soma exata (aritmOk = true)', r.aritmOk === true);
  assert('não são iguais (resíduo na última)', r.iguais === false);
  // Verificação explícita
  const soma = 0 + 333333 * 2 + 333334;
  assert(`soma manual = ${soma} = totalCts`, soma === 1000000);
}

// ── [2] 12 parcelas com entrada ───────────────────────────────────────────
grupo('[2] Total R$ 12.000,00, entrada R$ 1.000,00, 12 parcelas');
{
  // base = 11.000,00 = 1.100.000 cts
  // parcela = floor(1100000/12) = 91.666 cts (R$ 916,66)
  // última  = 1100000 - 91666*11 = 91.674 cts (R$ 916,74)
  const r = calcPlano(1200000, 100000, 'qtd', 12, 0);
  assert('n = 12', r.n === 12);
  assert('entradaCts = 100.000', r.entradaCts === 100000);
  assert('baseCts = 1.100.000', r.baseCts === 1100000);
  assert('parcelaCts = 91.666', r.parcelaCts === 91666);
  const expectedUltima = 1100000 - 91666 * 11;   // = 91.674
  assert(`ultimaCts = ${expectedUltima}`, r.ultimaCts === expectedUltima);
  assert('aritmOk = true', r.aritmOk === true);
}

// ── [3] Modo valor — resíduo de 1 centavo → absorção ─────────────────────
grupo('[3] Modo valor: R$ 1.000,01 ÷ R$ 500,00 → resíduo de R$ 0,01 absorvido');
{
  // n inicial = ceil(100001/50000) = 3; última inicial = 1 cts
  // 1 < ceil(50000/10)=5000 → absorver: n=2, última=50001
  const r = calcPlano(100001, 0, 'valor', 0, 50000);
  assert('resíduo absorvido → n = 2', r.n === 2);
  assert('parcelaCts = 50.000', r.parcelaCts === 50000);
  assert('ultimaCts = 50.001', r.ultimaCts === 50001);
  assert('aritmOk = true', r.aritmOk === true);
}

// ── [4] Modo valor — resíduo normal → NÃO absorver ───────────────────────
grupo('[4] Modo valor: R$ 1.000,00 ÷ R$ 300,00 → resíduo R$ 100,00 (não absorvido)');
{
  // n = ceil(100000/30000) = 4; última = 100000 - 30000*3 = 10000
  // 10000 >= ceil(30000/10)=3000 → não absorver
  const r = calcPlano(100000, 0, 'valor', 0, 30000);
  assert('n = 4', r.n === 4);
  assert('parcelaCts = 30.000', r.parcelaCts === 30000);
  assert('ultimaCts = 10.000', r.ultimaCts === 10000);
  assert('aritmOk = true', r.aritmOk === true);
  assert('iguais = false', r.iguais === false);
}

// ── [5] Modo valor — parcela zero → erro ─────────────────────────────────
grupo('[5] Modo valor: parcela = 0 → erro, sem crash');
{
  const r = calcPlano(100000, 0, 'valor', 0, 0);
  assert('erro definido', r.erro !== null);
  assert('n = 1 (graceful)', r.n === 1);
}

// ── [6] Modo valor — parcela > base → 1 parcela com valor da base ─────────
grupo('[6] Modo valor: parcela (R$ 600,00) > base (R$ 500,00) → 1 parcela');
{
  const r = calcPlano(50000, 0, 'valor', 0, 60000);
  assert('n = 1', r.n === 1);
  assert('parcelaCts = baseCts = 50.000', r.parcelaCts === 50000);
  assert('ultimaCts = 50.000', r.ultimaCts === 50000);
  assert('aritmOk = true', r.aritmOk === true);
}

// ── [7] Base zero (entrada = total) ──────────────────────────────────────
grupo('[7] Entrada exatamente igual ao total → base zero, soma fecha');
{
  const r = calcPlano(50000, 50000, 'qtd', 3, 0);
  assert('baseCts = 0', r.baseCts === 0);
  assert('parcelaCts = 0', r.parcelaCts === 0);
  assert('aritmOk = true', r.aritmOk === true);
}

// ── [8] Entrada maior que total → base zero, aritmOk false ───────────────
grupo('[8] Entrada > total → inconsistência detectada (aritmOk false)');
{
  const r = calcPlano(50000, 70000, 'qtd', 3, 0);
  assert('baseCts = 0 (max(0, negativo))', r.baseCts === 0);
  // Soma = entradaCts (70000) ≠ totalCts (50000): inconsistência corretamente detectada
  assert('aritmOk = false', r.aritmOk === false);
}

// ── [9] Parcela que divide exatamente → todas iguais ─────────────────────
grupo('[9] R$ 900,00 ÷ 3 = R$ 300,00 exatos, todas iguais');
{
  const r = calcPlano(90000, 0, 'qtd', 3, 0);
  assert('n = 3', r.n === 3);
  assert('parcelaCts = 30.000', r.parcelaCts === 30000);
  assert('ultimaCts = 30.000', r.ultimaCts === 30000);
  assert('iguais = true', r.iguais === true);
  assert('aritmOk = true', r.aritmOk === true);
}

// ── Resultado ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`Resultado: ${passou} ✓  ${falhou} ✗\n`);
if (falhou > 0) process.exit(1);
