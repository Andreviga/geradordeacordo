// tests/mascaras.test.js — P1.9: strToCents, formatos monetários e validações
//
// Testa strToCents isolado — lógica pura sem DOM.
// Cobre: EN (1234.56), BR (1.234,56 e 1234,56), colagem com R$, negativo rejeitado.

'use strict';

const path = require('path');
const src  = require('fs').readFileSync(path.join(__dirname, '../index.html'), 'utf8');

// Extrair strToCents do HTML
const fnStart = src.indexOf('function strToCents(raw)');
const fnEnd   = src.indexOf('\nfunction inputCents', fnStart);
if (fnStart === -1 || fnEnd === -1) { console.error('strToCents não encontrada'); process.exit(1); }
// eslint-disable-next-line no-new-func
const strToCents = new Function('raw', src.substring(fnStart + 'function strToCents(raw)'.length, fnEnd));

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else       { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

grupo('[1] Formato EN (ponto como decimal)');
{
  assert('1234.56 → 123456 cts', strToCents('1234.56') === 123456);
  assert('0.50 → 50 cts',        strToCents('0.50') === 50);
  assert('100 → 10000 cts',      strToCents('100') === 10000);
  assert('14919.50 → 1491950 cts', strToCents('14919.50') === 1491950);
}

grupo('[2] Formato BR (vírgula como decimal, pontos como milhar)');
{
  assert('1.234,56 → 123456 cts',  strToCents('1.234,56') === 123456);
  assert('1234,56 → 123456 cts',   strToCents('1234,56') === 123456);
  assert('14.919,50 → 1491950 cts',strToCents('14.919,50') === 1491950);
  assert('0,50 → 50 cts',          strToCents('0,50') === 50);
}

grupo('[3] Prefixo R$ (colagem do campo monetário)');
{
  assert('R$ 1.234,56 → 123456 cts', strToCents('R$ 1.234,56') === 123456);
  assert('R$500,00 → 50000 cts',     strToCents('R$500,00') === 50000);
}

grupo('[4] Negativos rejeitados (retorna 0)');
{
  assert('-100 → 0 cts',    strToCents('-100') === 0);
  assert('-1,50 → 0 cts',   strToCents('-1,50') === 0);
}

grupo('[5] Valores especiais');
{
  assert('null → 0',         strToCents(null) === 0);
  assert('undefined → 0',   strToCents(undefined) === 0);
  assert('string vazia → 0',strToCents('') === 0);
  assert('0 → 0',           strToCents('0') === 0);
  assert('0.00 → 0',        strToCents('0.00') === 0);
}

grupo('[6] d_total readonly e desconto limitado — presença no código');
{
  const veBody = src.substring(src.indexOf('function validarExportacao()'), src.indexOf('return{erros,avisos,html}'));
  assert('desconto limitado a original+encargos', veBody.includes('descCts>origCts+encCts2'));
  assert('d_total readonly quando demo ativo',    src.includes("dTotalEl.readOnly=demoAtivo"));
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`Resultado: ${passou} ✓  ${falhou} ✗\n`);
if (falhou > 0) process.exit(1);
