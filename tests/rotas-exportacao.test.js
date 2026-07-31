// tests/rotas-exportacao.test.js
// Verifica estruturalmente que cada rota de exportação de documento
// chama podeExportar() antes de gerar qualquer artefato.
//
// Não é um teste de runtime — lê o código-fonte e analisa a estrutura.

'use strict';

const fs   = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

// Extrai o corpo de uma função pelo nome
function extrairCorpo(nome) {
  const pat1 = `function ${nome}(`;
  const pat2 = `async function ${nome}(`;
  const idx1 = html.indexOf(pat1);
  const idx2 = html.indexOf(pat2);
  const idx  = Math.min(
    idx1 === -1 ? Infinity : idx1,
    idx2 === -1 ? Infinity : idx2
  );
  if (idx === Infinity) return null;
  const start = html.indexOf('{', idx) + 1;
  let depth = 1, i = start;
  while (i < html.length && depth > 0) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') depth--;
    i++;
  }
  return html.slice(start, i - 1);
}

// Rotas que DEVEM chamar podeExportar()
const ROTAS_DOCUMENTO = [
  'exportWord',
  'printPdf',
  'baixarPdf',
  'salvarWordDrive',
  'salvarPdfDrive',
  'enviarAdobeSign',
];

// Rotas que NÃO precisam chamar podeExportar() (sem exportação de documento)
const ROTAS_DADOS = [
  'salvarDrive',   // salva JSON de dados, não documento
  'saveJson',      // download JSON local
];

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else       { console.error(`  ✗ ${desc}`); falhou++; }
}

console.log('\n[Rotas de exportação de documento chamam podeExportar()]\n');
for (const fn of ROTAS_DOCUMENTO) {
  const corpo = extrairCorpo(fn);
  if (!corpo) {
    console.error(`  ✗ Função ${fn}() não encontrada no código`);
    falhou++;
    continue;
  }
  assert(`${fn}() chama podeExportar()`, corpo.includes('podeExportar()'));
}

console.log('\n[Rotas de dados NÃO chamam podeExportar() — correto]\n');
for (const fn of ROTAS_DADOS) {
  const corpo = extrairCorpo(fn);
  if (!corpo) {
    console.log(`  – ${fn}() não encontrada (pode ter sido renomeada)`);
    continue;
  }
  assert(
    `${fn}() não bloqueia exportação de dados`,
    !corpo.includes('podeExportar()')
  );
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`Resultado: ${passou} ✓  ${falhou} ✗\n`);
if (falhou > 0) process.exit(1);
