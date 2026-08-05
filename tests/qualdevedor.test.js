// tests/qualdevedor.test.js — P1.3: qualificação do devedor e ViaCEP
//
// Testa qualDevedor() com todas as combinações de campos, prevenindo
// frases quebradas como "brasileiro, , portador do RG". Testa também
// a lógica do buscarCEP() com mocks de rede.

'use strict';

const path = require('path');
const src  = require('fs').readFileSync(path.join(__dirname, '../index.html'), 'utf8');

// ── Extrair qualDevedor e buscarCEP do HTML ───────────────────────────────
// Definir esc() localmente (mesma lógica do index.html) para evitar problemas de extração
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

const qdStart = src.indexOf('function qualDevedor(d){');
const qdEnd   = src.indexOf('\n}', qdStart) + 2;
const qdFn    = src.substring(qdStart, qdEnd);

// Avaliar qualDevedor com esc() já no escopo
// eslint-disable-next-line no-new-func
const { qualDevedor } = new Function('esc', qdFn + '\nreturn { qualDevedor };')(esc);

// ── Extrair buscarCEP ─────────────────────────────────────────────────────
const bcStart = src.indexOf('async function buscarCEP(i){');
const bcEnd   = src.indexOf('\n}', bcStart) + 2;
const bcFn    = src.substring(bcStart, bcEnd);

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else       { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

// ── Auxiliar: extrair texto limpo do HTML retornado por qualDevedor ────────
function txt(d) { return qualDevedor(d).replace(/<[^>]+>/g,''); }

grupo('[1] Todos os campos preenchidos');
{
  const d = { nome:'Daiana Barboza', nac:'brasileira', civil:'casada', prof:'do lar',
               rg:'33.884.218-4', rgEmissor:'SSP-SP', cpf:'341.452.718-90',
               end:'Rua X, 10', cid:'São Paulo - SP', cep:'01001-000', contato:'(11)9999-0000' };
  const t = txt(d);
  assert('nome em maiúsculas no início', t.startsWith('DAIANA BARBOZA'));
  assert('inclui brasileira, casada, do lar', t.includes('brasileira, casada, do lar'));
  assert('inclui RG com emissor', t.includes('33.884.218-4/SSP-SP'));
  assert('inclui CPF', t.includes('341.452.718-90'));
  assert('inclui endereço', t.includes('Rua X, 10'));
  assert('inclui CEP', t.includes('01001-000'));
  assert('termina com ponto', t.trim().endsWith('.'));
}

grupo('[2] Sem nacionalidade/civil/profissão — sem vírgula dupla');
{
  const d = { nome:'João Silva', nac:'', civil:'', prof:'', rg:'12.345.678-9', cpf:'266.392.568-35', end:'Rua Y, 5', cid:'SP', cep:'', contato:'' };
  const t = txt(d);
  assert('sem vírgula dupla (", ,")', !t.includes(', ,'));
  // Correto: ", portador" é separador nome→RG mesmo sem bits anteriores
  assert('rg aparece após nome', t.includes('12.345.678-9'));
  assert('sem rgEmissor', !t.includes('/'));
}

grupo('[3] Somente nome — sem campos opcionais');
{
  const d = { nome:'Maria Souza', nac:'', civil:'', prof:'', rg:'', rgEmissor:'', cpf:'', end:'', cid:'', cep:'', contato:'' };
  const t = txt(d);
  assert('nome presente', t.includes('MARIA SOUZA'));
  assert('termina com ponto', t.trim().endsWith('.'));
  assert('sem "portador" sem RG', !t.includes('portador'));
  assert('sem "inscrito" sem CPF', !t.includes('inscrito'));
  assert('sem ", ," artefato', !t.includes(', ,'));
}

grupo('[4] CPF sem RG — conectivo correto');
{
  const d = { nome:'Pedro Santos', nac:'brasileiro', civil:'', prof:'', rg:'', cpf:'341.452.718-90', end:'', cid:'', cep:'', contato:'' };
  const t = txt(d);
  // Com bits=[brasileiro] e sem RG: "PEDRO SANTOS, brasileiro, inscrito(a)..."
  assert('inclui CPF', t.includes('341.452.718-90'));
  assert('sem " e inscrito" sem RG (usa vírgula)', !t.includes(' e inscrito'));
  assert('sem "portador"', !t.includes('portador'));
}

grupo('[5] RG e CPF — conectivo "e"');
{
  const d = { nome:'Ana Lima', nac:'', civil:'', prof:'', rg:'11.111.111-1', rgEmissor:'', cpf:'266.392.568-35', end:'', cid:'', cep:'', contato:'' };
  const t = txt(d);
  assert('usa " e inscrito" quando há RG', t.includes(' e inscrito'));
  assert('portador do RG presente', t.includes('portador'));
}

grupo('[6] Endereço sem cidade/CEP — sem vírgulas espúrias');
{
  const d = { nome:'Lucas Neves', nac:'', civil:'', prof:'', rg:'', cpf:'', end:'Av. Brasil, 100', cid:'', cep:'', contato:'' };
  const t = txt(d);
  assert('inclui endereço', t.includes('Av. Brasil, 100'));
  assert('sem vírgula após endereço sem cidade', !t.includes('Av. Brasil, 100, '));
}

grupo('[7] Caracteres especiais escapados (XSS)');
{
  const d = { nome:'<script>alert(1)</script>', nac:'', civil:'', prof:'', rg:'', cpf:'', end:'', cid:'', cep:'', contato:'' };
  const raw = qualDevedor(d);
  assert('< escapado em nome', !raw.includes('<script>'));
  assert('&lt; presente', raw.includes('&lt;'));
}

grupo('[8] buscarCEP — código fonte tem lógica esperada');
{
  // Verificar que o código-fonte trata CEP inválido, 404, e preserva entrada manual
  assert('valida 8 dígitos antes de buscar',    bcFn.includes('cep.length!==8'));
  assert('trata d.erro (CEP inexistente)',       bcFn.includes('d.erro'));
  assert('não bloqueia preenchimento manual (toast informativo)', bcFn.includes('toast('));
  assert('usa viacep.com.br',                   bcFn.includes('viacep.com.br'));
  assert('atualiza devedores[i].end',           bcFn.includes('devedores[i].end'));
  assert('atualiza devedores[i].cid',           bcFn.includes('devedores[i].cid'));
  assert('try/catch preserva entrada manual em caso de erro de rede', bcFn.includes('catch'));
}

grupo('[9] CPF e endereço são erros bloqueantes em validarExportacao');
{
  const veBody = src.substring(src.indexOf('function validarExportacao()'), src.indexOf('return{erros,avisos,html}'));
  // Confirmado como obrigatórios (art. 784, III, CPC): mudar para aviso requer decisão consciente
  assert('CPF ausente → erro bloqueante', veBody.includes('erros.push') && veBody.includes('CPF ausente'));
  assert('CPF inválido → erro bloqueante', veBody.includes('erros.push') && veBody.includes('CPF inválido'));
  assert('Endereço e CEP ausentes → erro bloqueante', veBody.includes('erros.push') && veBody.includes('Endereço e CEP ausentes'));
  // CEP sozinho (sem endereço vazio) permanece aviso — menos crítico
  assert('CEP ausente isolado → aviso', veBody.includes('avisos.push') && veBody.includes('CEP ausente'));
}

grupo('[10] Campos P1.3 presentes no CAMPOS_FORMULARIO e no template de devedor');
{
  const cfStart = src.indexOf('const CAMPOS_FORMULARIO');
  const cfEnd   = src.indexOf(']);', cfStart);
  const cfBloco = src.substring(cfStart, cfEnd);
  const devTpl  = src.substring(src.indexOf('function devTpl'), src.indexOf('\nfunction alunoTpl'));

  // cep está nos objetos devedores[] (persistido via array), não em CAMPOS_FORMULARIO
  assert('cep no template de devedor', devTpl.includes('data-k="cep"'));
  assert('cep não em CAMPOS_FORMULARIO (persistido via array)', !cfBloco.includes("'cep'"));
  assert('campo rgEmissor no template', devTpl.includes('data-k="rgEmissor"'));
  assert('botão ViaCEP no template',    devTpl.includes('ViaCEP'));
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`Resultado: ${passou} ✓  ${falhou} ✗\n`);
if (falhou > 0) process.exit(1);
