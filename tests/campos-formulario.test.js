// tests/campos-formulario.test.js
// Compara CAMPOS_FORMULARIO (allowlist de persistência) com todos os IDs
// de inputs estáticos no HTML.
//
// Se um novo campo for adicionado ao formulário e esquecido na allowlist,
// este teste falha — impedindo perda silenciosa de dados no save/load.

'use strict';

const fs   = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

// Extrai CAMPOS_FORMULARIO do JavaScript
function extrairCamposFormulario() {
  const m = html.match(/const CAMPOS_FORMULARIO=new Set\(\[([\s\S]*?)\]\)/);
  if (!m) return null;
  return new Set((m[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1)));
}

// Extrai IDs de inputs/selects/textareas do HTML estático (sem as tags <script>)
function extrairIdsDoHTML() {
  const semScript = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  const matches   = semScript.matchAll(/<(?:input|select|textarea)[^>]+\bid="([^"]+)"/gi);
  return new Set([...matches].map(m => m[1]));
}

// IDs no DOM que intencionalmente NÃO fazem parte dos dados persistidos
const EXCLUIDOS = new Set([
  'imp',          // input[type=file] oculto para carregar JSON
  'g_arquivos',   // select de lista de arquivos do Drive (UI, não dado) — seção 10 removida
  'lib',          // select de biblioteca de cláusulas (UI, não dado)
  'loginSenha',   // input[type=password] do modal de login (jamais persistido)
  'loginEmail',   // input[type=email] do modal de login (jamais persistido)
  'resetEmail',   // campo do painel "Esqueci minha senha" (não faz parte do formulário)
  'novaSenha1',   // campo nova senha do reset (não faz parte do formulário)
  'novaSenha2',   // campo confirmar senha do reset (não faz parte do formulário)
]);

const campos = extrairCamposFormulario();
const idsDOM  = extrairIdsDoHTML();

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else       { console.error(`  ✗ ${desc}`); falhou++; }
}

console.log('\n[CAMPOS_FORMULARIO vs IDs no DOM]\n');

if (!campos) {
  console.error('  ✗ CAMPOS_FORMULARIO não encontrada em index.html');
  process.exit(1);
}

// IDs no DOM que não estão na allowlist (e não são excluídos intencionalmente)
const noDOM_naoEmCampos = [...idsDOM].filter(id => !campos.has(id) && !EXCLUIDOS.has(id));

// IDs na allowlist que não existem no DOM (campo removido sem atualizar a allowlist)
const emCampos_naoNoDOM = [...campos].filter(id => !idsDOM.has(id));

if (noDOM_naoEmCampos.length > 0) {
  console.error('  IDs no DOM mas FORA da allowlist (dados não serão salvos/restaurados):');
  noDOM_naoEmCampos.forEach(id => console.error(`    ⚠ ${id}`));
}
if (emCampos_naoNoDOM.length > 0) {
  console.error('  IDs na allowlist sem correspondente no DOM (campo removido?):');
  emCampos_naoNoDOM.forEach(id => console.error(`    ⚠ ${id}`));
}

assert(
  'Nenhum input estático fora da allowlist (sem perda silenciosa)',
  noDOM_naoEmCampos.length === 0
);
assert(
  'Nenhum ID na allowlist sem correspondente no DOM (sem órfão)',
  emCampos_naoNoDOM.length === 0
);

console.log(`\n${'─'.repeat(54)}`);
console.log(`Resultado: ${passou} ✓  ${falhou} ✗\n`);
if (falhou > 0) process.exit(1);
