// Testes unitários de classificarTokensNoHTML()
// Execute com: node tests/validar-tokens.test.js
//
// IMPORTANTE: classificarTokensNoHTML() é definida em index.html.
// Esta cópia deve permanecer em sincronia com aquela.

'use strict';

// ── Cópia da função pura (sincronizar com index.html) ─────────────────────
function classificarTokensNoHTML(html, validos) {
  const erros = [], avisos = [];
  const RE = /\{\{([^}]*)\}\}/g;
  const orphans = new Set();
  let m;
  while ((m = RE.exec(html)) !== null) {
    const nome = m[1].trim();
    if (!validos.has(nome)) orphans.add(nome || '(vazio)');
  }
  orphans.forEach(nome => erros.push('Token não reconhecido no documento: {{' + nome + '}}'));
  const abre  = (html.match(/\{\{/g) || []).length;
  const fecha = (html.match(/\}\}/g) || []).length;
  if (abre !== fecha)
    avisos.push(`Chave desbalanceada: ${abre} × "{{" vs ${fecha} × "}}" no documento — verifique as cláusulas.`);
  return { erros, avisos };
}

// ── Utilidades de teste ────────────────────────────────────────────────────
let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else       { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(titulo) { console.log('\n' + titulo); }

const VALIDOS = new Set(['total','totalExt','DEV','CRED','daCred','pelaCred','foro',
  'data1Ext','nParcelas','nParcelasExt','valorParcela','meio',
  'tabelaParcelas','listaParcelas','demonstrativo','divisaoCredito']);

// ── [1] Token desconhecido no corpo ────────────────────────────────────────
grupo('[1] Token desconhecido no corpo');
{
  const r = classificarTokensNoHTML('<p>Valor: {{foo}}</p>', VALIDOS);
  assert('gera 1 erro bloqueante', r.erros.length === 1);
  assert('mensagem menciona o token', r.erros[0].includes('{{foo}}'));
  assert('nenhum aviso', r.avisos.length === 0);
}

// ── [2] {{ foo }} com espaços internos ─────────────────────────────────────
grupo('[2] {{ foo }} com espaços internos — detectado e normalizado');
{
  const r = classificarTokensNoHTML('<p>{{ foo }}</p>', VALIDOS);
  assert('foo não está em VALIDOS → erro', r.erros.length === 1);
  assert('mensagem mostra {{foo}} sem espaços', r.erros[0].includes('{{foo}}'));
}

// ── [3] Token válido ────────────────────────────────────────────────────────
grupo('[3] {{total}} token válido — não bloqueia');
{
  const r = classificarTokensNoHTML('<p>Total: {{total}} ({{totalExt}})</p>', VALIDOS);
  assert('nenhum erro', r.erros.length === 0);
  assert('nenhum aviso', r.avisos.length === 0);
}

// ── [4] {{valor total}} com espaço no nome ──────────────────────────────────
grupo('[4] {{valor total}} com espaço no nome — detectado (regex antiga falharia)');
{
  const r = classificarTokensNoHTML('<p>{{valor total}}</p>', VALIDOS);
  assert('detecta como orphan', r.erros.length === 1);
}

// ── [5] {{foo:bar}} com dois pontos ────────────────────────────────────────
grupo('[5] {{foo:bar}} com dois pontos — detectado (regex antiga falharia)');
{
  const r = classificarTokensNoHTML('<p>{{foo:bar}}</p>', VALIDOS);
  assert('detecta como orphan', r.erros.length === 1);
}

// ── [6] {{}} vazio ─────────────────────────────────────────────────────────
grupo('[6] {{}} vazio — detectado');
{
  const r = classificarTokensNoHTML('<p>{{}}</p>', VALIDOS);
  assert('detecta como orphan (vazio)', r.erros.length === 1);
  assert('mensagem menciona (vazio)', r.erros[0].includes('(vazio)'));
}

// ── [7] Documento limpo — não bloqueia ─────────────────────────────────────
grupo('[7] Documento sem tokens — não bloqueia');
{
  const r = classificarTokensNoHTML('<p>Texto normal, sem tokens.</p>', VALIDOS);
  assert('nenhum erro', r.erros.length === 0);
  assert('nenhum aviso', r.avisos.length === 0);
}

// ── [8] Token em campo de cabeçalho simulado ───────────────────────────────
grupo('[8] Token inválido em campo de cabeçalho (simulado no HTML)');
{
  const html = '<b>Título: {{razaoSocial}}</b><p>Corpo do documento.</p>';
  const r = classificarTokensNoHTML(html, VALIDOS);
  assert('token no cabeçalho simulado é detectado', r.erros.length === 1);
}

// ── [9] Chave desbalanceada — aviso não bloqueante ─────────────────────────
grupo('[9] Chave desbalanceada {{foo sem fechar — aviso, não erro bloqueante');
{
  // "{{foo sem fechar" tem 1 × {{ e 0 × }}
  const r = classificarTokensNoHTML('<p>{{foo sem fechar</p>', VALIDOS);
  assert('nenhum erro bloqueante', r.erros.length === 0);
  assert('aviso de chave desbalanceada', r.avisos.length === 1);
  assert('aviso menciona contagem', r.avisos[0].includes('{{'));
}

// ── [10] Múltiplos tokens: válido, inválido ────────────────────────────────
grupo('[10] Mistura: {{total}} válido + {{bar}} inválido + {{DEV}} válido');
{
  const r = classificarTokensNoHTML('<p>{{total}} {{bar}} {{DEV}}</p>', VALIDOS);
  assert('1 erro (bar)', r.erros.length === 1);
  assert('erro menciona bar', r.erros[0].includes('bar'));
  assert('nenhum aviso', r.avisos.length === 0);
}

// ── [11] Token no rodapé simulado ─────────────────────────────────────────
grupo('[11] {{fooRodape}} no rodapé — detectado');
{
  const html = '<div class="rodape">{{fooRodape}}</div><p>Corpo.</p>';
  const r = classificarTokensNoHTML(html, VALIDOS);
  assert('erro detectado no rodapé simulado', r.erros.length === 1);
}

// ── [12] Tokens válidos não geram erros mesmo em cabeçalho ─────────────────
grupo('[12] {{foro}} e {{DEV}} no cabeçalho simulado — não bloqueiam');
{
  const html = '<b>Foro: {{foro}}</b><p>{{DEV}}</p>';
  const r = classificarTokensNoHTML(html, VALIDOS);
  assert('nenhum erro', r.erros.length === 0);
}

// ── [P1.8] Estrutura de erros de validarExportacao ────────────────────────
grupo('[P1.8] Erros de validação carregam {msg, secao, campo} — não strings brutas');
{
  // Simula a verificação estrutural lendo o código-fonte do index.html
  const htmlSrc = require('fs').readFileSync(require('path').join(__dirname, '../index.html'), 'utf8');
  // Cada erros.push dentro de validarExportacao deve passar um objeto {msg,...}
  // A presença de `e(` (helper) ou `a(` como primeiros argumentos confirma
  const veStart = htmlSrc.indexOf('function validarExportacao(){');
  const veEnd   = htmlSrc.indexOf('return{erros,avisos,html};', veStart);
  const veBody  = htmlSrc.substring(veStart, veEnd);
  // Não deve haver erros.push('string literal') — apenas erros.push(e(
  const rawStringPush = /erros\.push\('[^)]+'\)/.test(veBody);
  assert('erros.push só recebe objetos (via helper e())', !rawStringPush);
  assert('token errors wrapped: errosToken.map(msg=>e(', veBody.includes('errosToken.map(msg=>e('));
  assert('avisos wrapped: avisosToken.map(msg=>a(', veBody.includes('avisosToken.map(msg=>a('));
}

// ── Resultado ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
console.log(`Resultado: ${passou} ✓  ${falhou} ✗\n`);
if (falhou > 0) process.exit(1);
