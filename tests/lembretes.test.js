// tests/lembretes.test.js — calcularEvento: fronteiras de todas as faixas
'use strict';

const { calcularEvento } = require('../api/cron/_calcularEvento');

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  \u2713 ${desc}`); passou++; }
  else       { console.error(`  \u2717 ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

grupo('[1] Fora de todas as faixas — null');
{
  assert('dias = 4: muito cedo para D-3',              calcularEvento(4)   === null);
  assert('dias = 100: muito antes do vencimento',      calcularEvento(100) === null);
  assert('dias = 0: dia do vencimento (sem lembrete)', calcularEvento(0)   === null);
}

grupo('[2] D-3: dias ∈ [1, 3]');
{
  assert('dias = 3: limite superior',   calcularEvento(3)  === 'D-3');
  assert('dias = 2: meio da faixa',     calcularEvento(2)  === 'D-3');
  assert('dias = 1: limite inferior',   calcularEvento(1)  === 'D-3');
}

grupo('[3] D+1: dias ∈ [-6, -1]');
{
  assert('dias = -1: limite superior',  calcularEvento(-1) === 'D+1');
  assert('dias = -3: meio da faixa',    calcularEvento(-3) === 'D+1');
  assert('dias = -6: limite inferior',  calcularEvento(-6) === 'D+1');
}

grupo('[4] D+7: dias ∈ [-14, -7]');
{
  assert('dias = -7: limite superior',  calcularEvento(-7)  === 'D+7');
  assert('dias = -10: meio da faixa',   calcularEvento(-10) === 'D+7');
  assert('dias = -14: limite inferior', calcularEvento(-14) === 'D+7');
}

grupo('[5] D+15: dias ≤ -15');
{
  assert('dias = -15: início da faixa', calcularEvento(-15) === 'D+15');
  assert('dias = -16: dentro da faixa', calcularEvento(-16) === 'D+15');
  assert('dias = -90: caso extremo',    calcularEvento(-90) === 'D+15');
}

grupo('[6] Fronteiras entre faixas (nenhum gap, nenhuma sobreposição)');
{
  // Gap entre null e D-3
  assert('4 → null (não D-3)',  calcularEvento(4)  === null);
  assert('3 → D-3  (não null)', calcularEvento(3)  === 'D-3');
  // Gap entre D-3 e null(dia 0)
  assert('1 → D-3  (não null)', calcularEvento(1)  === 'D-3');
  assert('0 → null (não D-3)',  calcularEvento(0)  === null);
  // Gap entre null(dia 0) e D+1
  assert('0  → null (não D+1)', calcularEvento(0)  === null);
  assert('-1 → D+1  (não null)',calcularEvento(-1) === 'D+1');
  // Fronteira D+1 / D+7
  assert('-6 → D+1  (não D+7)',  calcularEvento(-6)  === 'D+1');
  assert('-7 → D+7  (não D+1)',  calcularEvento(-7)  === 'D+7');
  // Fronteira D+7 / D+15
  assert('-14 → D+7  (não D+15)', calcularEvento(-14) === 'D+7');
  assert('-15 → D+15 (não D+7)',  calcularEvento(-15) === 'D+15');
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`Resultado: ${passou} \u2713  ${falhou} \u2717\n`);
if (falhou > 0) process.exit(1);
