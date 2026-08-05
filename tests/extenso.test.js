// tests/extenso.test.js — P1.2: valor por extenso e tokens combinados
//
// Testa extValor, extInt, extF importados do index.html via extração de função.
// Cobre: inteiros, frações, feminino (vias), plural, centavos zerados, acima de 1 milhão.

'use strict';

const path = require('path');
const src  = require('fs').readFileSync(path.join(__dirname, '../index.html'), 'utf8');

// Extrair e avaliar as funções de extenso do HTML
const functionsToExtract = ['ext3', 'extInt', 'extF', 'extValor'];
const startMarker = 'const U=[';
const endMarker   = 'function pct(v)';
const start = src.indexOf(startMarker);
const end   = src.indexOf(endMarker, start);
if (start === -1 || end === -1) { console.error('Funções de extenso não encontradas'); process.exit(1); }
const snippet = src.substring(start, end);

// Avaliar em contexto isolado
const { ext3, extInt, extF, extValor } = (() => {
  // eslint-disable-next-line no-new-func
  const fn = new Function(snippet + '\nreturn { ext3, extInt, extF, extValor };');
  return fn();
})();

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else       { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

grupo('[1] extInt — inteiros básicos');
{
  assert('zero',         extInt(0) === 'zero');
  assert('um',           extInt(1) === 'um');
  assert('dez',          extInt(10) === 'dez');
  assert('cem',          extInt(100) === 'cem');
  assert('cento e um',   extInt(101) === 'cento e um');
  assert('mil',          extInt(1000) === 'mil');
  assert('dois mil',     extInt(2000) === 'dois mil');
}

grupo('[2] extF — feminino (vias, parcelas)');
{
  assert('uma',   extF(1) === 'uma');
  assert('duas',  extF(2) === 'duas');
  assert('três',  extF(3) === 'três');
  assert('dez',   extF(10) === 'dez');
}

grupo('[3] extValor — reais e centavos');
{
  assert('zero real',          extValor(0) === 'zero real');
  assert('um real',            extValor(1) === 'um real');
  assert('dois reais',         extValor(2) === 'dois reais');
  assert('um real e cinquenta centavos', extValor(1.50) === 'um real e cinquenta centavos');
  assert('dez reais',          extValor(10) === 'dez reais');
  assert('centavos zerados: R$100 = cem reais (sem centavos)', extValor(100) === 'cem reais');
  assert('vinte e cinco centavos', extValor(0.25) === 'vinte e cinco centavos');
}

grupo('[4] extValor — acima de mil');
{
  assert('mil reais',          extValor(1000) === 'mil reais');
  assert('dez mil reais',      extValor(10000) === 'dez mil reais');
  assert('cento e quarenta e nove reais', extValor(149.19).startsWith('cento e quarenta e nove reais'));
}

grupo('[5] extValor — acima de um milhão');
{
  const v = extValor(1000000);
  assert('um milhão reais', v === 'um milhão reais');
  const v2 = extValor(2500000);
  assert('dois milhões, quinhentos mil reais', v2 === 'dois milhões, quinhentos mil reais');
}

grupo('[6] Tokens de extenso presentes no código fonte');
{
  assert('valorTotalExtenso definido',    src.includes('valorTotalExtenso'));
  assert('valorOriginalExtenso definido', src.includes('valorOriginalExtenso'));
  assert('entradaExtenso definido',       src.includes('entradaExtenso'));
  assert('valorParcelaExtenso definido',  src.includes('valorParcelaExtenso'));
}

grupo('[7] Tokens em VALIDOS (validação não os bloqueia)');
{
  const tokenList = src.slice(src.indexOf("'{{valorTotalExtenso}}'"), src.indexOf("'{{ref:reconhecimento}}'") + 30);
  assert('valorTotalExtenso na lista de tokens', tokenList.includes('valorTotalExtenso'));
  assert('valorOriginalExtenso na lista de tokens', tokenList.includes('valorOriginalExtenso'));
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`Resultado: ${passou} ✓  ${falhou} ✗\n`);
if (falhou > 0) process.exit(1);
