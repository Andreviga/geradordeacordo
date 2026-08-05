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
// salvarWordDrive e salvarPdfDrive removidas: seção 10 (Google Drive OAuth) foi substituída
// pela service account no servidor (api/assinatura/_drive.js)
const ROTAS_DOCUMENTO = [
  'exportWord',
  'printPdf',
  'baixarPdf',
  'enviarAssinatura',   // substitui enviarAdobeSign como rota principal
];

// Rotas que NÃO precisam chamar podeExportar() (sem exportação de documento)
const ROTAS_DADOS = [
  'saveJson',           // download JSON local
  'enviarAdobeSign',    // stub que delega para enviarAssinatura()
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
  const desc = fn === 'enviarAdobeSign'
    ? `${fn}() é stub que delega para enviarAssinatura() (não chama diretamente)`
    : `${fn}() não bloqueia exportação de dados`;
  assert(desc, !corpo.includes('podeExportar()'));
}

// Varredura estrutural: nenhuma função chamada por onclick pode chamar
// podeExportar() sem estar declarada em ROTAS_DOCUMENTO.
// Isso detecta novos pontos de entrada sem atualizar a lista.
console.log('\n[Cobertura derivada do HTML: nenhuma rota de exportação fora das listas]\n');
const todasDeclaradas = new Set([...ROTAS_DOCUMENTO, ...ROTAS_DADOS]);
const fnOnclick = [...html.matchAll(/onclick="(\w+)\(/g)].map(m => m[1]);
const naoCobertas = [...new Set(fnOnclick)].filter(fn => {
  if (todasDeclaradas.has(fn)) return false;
  const corpo = extrairCorpo(fn);
  return corpo && corpo.includes('podeExportar()');
});
if (naoCobertas.length) console.error('  Funções não declaradas que chamam podeExportar():', naoCobertas);
assert('Nenhuma rota de exportação fora das listas testadas', naoCobertas.length === 0);

// abrirNovaAba: revalida via podeExportar() no caminho de erro (catch de exportWord/printPdf)
console.log('\n[abrirNovaAba: revalida no caminho de erro]\n');
{
  const corpo = extrairCorpo('abrirNovaAba');
  assert('abrirNovaAba revalida via podeExportar()', corpo?.includes('podeExportar()'));
  assert('abrirNovaAba sem fallback wordHtml() sem validação', !corpo?.includes('wordHtml()'));
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`Resultado: ${passou} ✓  ${falhou} ✗\n`);
if (falhou > 0) process.exit(1);
