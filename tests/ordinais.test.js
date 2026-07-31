// tests/ordinais.test.js — Fase D / P1.10: ordinais de 1 a 40
//
// Cópia de ORD de index.html — manter sincronizado.
// Execute: node tests/ordinais.test.js

'use strict';

// Cópia do array ORD de index.html
const ORD = [
  'Primeira','Segunda','Terceira','Quarta','Quinta','Sexta','Sétima','Oitava','Nona','Décima',
  'Décima Primeira','Décima Segunda','Décima Terceira','Décima Quarta','Décima Quinta',
  'Décima Sexta','Décima Sétima','Décima Oitava','Décima Nona','Vigésima',
  'Vigésima Primeira','Vigésima Segunda','Vigésima Terceira','Vigésima Quarta','Vigésima Quinta',
  'Vigésima Sexta','Vigésima Sétima','Vigésima Oitava','Vigésima Nona','Trigésima',
  'Trigésima Primeira','Trigésima Segunda','Trigésima Terceira','Trigésima Quarta','Trigésima Quinta',
  'Trigésima Sexta','Trigésima Sétima','Trigésima Oitava','Trigésima Nona','Quadragésima',
];

// Gabarito completo (índice 0 = 1ª cláusula)
const GABARITO = [
  'Primeira',        // 1
  'Segunda',         // 2
  'Terceira',        // 3
  'Quarta',          // 4
  'Quinta',          // 5
  'Sexta',           // 6
  'Sétima',          // 7
  'Oitava',          // 8
  'Nona',            // 9
  'Décima',          // 10
  'Décima Primeira', // 11
  'Décima Segunda',  // 12
  'Décima Terceira', // 13
  'Décima Quarta',   // 14
  'Décima Quinta',   // 15
  'Décima Sexta',    // 16
  'Décima Sétima',   // 17
  'Décima Oitava',   // 18
  'Décima Nona',     // 19
  'Vigésima',        // 20
  'Vigésima Primeira',// 21
  'Vigésima Segunda', // 22
  'Vigésima Terceira',// 23
  'Vigésima Quarta',  // 24
  'Vigésima Quinta',  // 25
  'Vigésima Sexta',   // 26
  'Vigésima Sétima',  // 27
  'Vigésima Oitava',  // 28
  'Vigésima Nona',    // 29
  'Trigésima',        // 30
  'Trigésima Primeira',// 31
  'Trigésima Segunda', // 32
  'Trigésima Terceira',// 33
  'Trigésima Quarta',  // 34
  'Trigésima Quinta',  // 35
  'Trigésima Sexta',   // 36
  'Trigésima Sétima',  // 37
  'Trigésima Oitava',  // 38
  'Trigésima Nona',    // 39
  'Quadragésima',      // 40
];

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else       { console.error(`  ✗ ${desc}`); falhou++; }
}

console.log('\n[Ordinais 1-40 — ORD de index.html vs gabarito]\n');

assert('ORD tem 40 entradas', ORD.length === 40);
assert('GABARITO tem 40 entradas', GABARITO.length === 40);

for (let i = 0; i < GABARITO.length; i++) {
  assert(
    `ORD[${i}] = ${(i+1)}ª = "${GABARITO[i]}"`,
    ORD[i] === GABARITO[i]
  );
}

// Verificações específicas críticas
console.log('\n[Verificações críticas de sequência]\n');
assert('6ª = Sexta (não Sétima)',     ORD[5] === 'Sexta');
assert('7ª = Sétima (não Sexta)',     ORD[6] === 'Sétima');
assert('20ª = Vigésima',             ORD[19] === 'Vigésima');
assert('30ª = Trigésima',            ORD[29] === 'Trigésima');
assert('40ª = Quadragésima',         ORD[39] === 'Quadragésima');
assert('Fallback para n>40 = n+ª',   (ORD[40] === undefined));

console.log(`\n${'─'.repeat(50)}`);
console.log(`Resultado: ${passou} ✓  ${falhou} ✗\n`);
if (falhou > 0) process.exit(1);
