'use strict';
// Verifica se o bloco <script> principal do index.html é JavaScript válido.
// Pega antes que erros de sintaxe — como os 3 desta sessão — cheguem ao browser.

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const assert = (msg, ok, detalhe) => {
  if (ok) { console.log('  ✓', msg); passou++; }
  else    { console.error('  ✗', msg, detalhe || ''); falhou++; }
};
let passou = 0, falhou = 0;

const htmlPath = path.join(__dirname, '../index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// Extrai todos os blocos <script> inline
const blocos = [...html.matchAll(/<script(?:\s[^>]*)?>(?!.*src)([\s\S]*?)<\/script>/gi)]
  .map((m, i) => ({ idx: i, src: m[1] }))
  .filter(b => b.src.trim().length > 50); // ignora blocos triviais

console.log(`\n[HTML syntax] index.html — ${blocos.length} bloco(s) de script inline`);

blocos.forEach(({ idx, src }) => {
  try {
    new vm.Script(src);
    assert(`Bloco ${idx + 1} (${src.length} chars): sintaxe válida`, true);
  } catch (e) {
    // Linha do erro dentro do bloco
    const linha = e.lineNumber || '?';
    const preview = src.split('\n')[linha - 1]?.trim().substring(0, 80) || '';
    assert(
      `Bloco ${idx + 1} (${src.length} chars): sintaxe válida`,
      false,
      `\n    SyntaxError na linha ${linha}: ${e.message}\n    → ${preview}`
    );
  }
});

console.log(`\nResultado: ${passou} ✓  ${falhou} ✗`);
if (falhou > 0) process.exit(1);
