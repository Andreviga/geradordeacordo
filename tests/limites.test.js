// tests/limites.test.js — P1.1: limites legais CDC e cumulação de encargos
//
// Testa os avisos não-bloqueantes de render() via análise do código fonte.
// Os cálculos são simples (comparação de números) — testados aqui como lógica pura.

'use strict';

const path = require('path');
const html = require('fs').readFileSync(path.join(__dirname, '../index.html'), 'utf8');

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else       { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

// Extrair o bloco de avisos_percentuais do render()
function extrairBlocoAvisos() {
  const start = html.indexOf('avisos_percentuais');
  const end   = html.indexOf('avP.style.display', start) + 50;
  return html.substring(start, end);
}

grupo('[1] Default de multa moratória é 2% (valor do atributo)');
{
  assert('e_multamora value="2" no HTML', html.includes('id="e_multamora" value="2"'));
}

grupo('[2] Lógica de aviso: mora > 2% dispara alerta');
{
  const bloco = extrairBlocoAvisos();
  assert('condição mora>2 presente', bloco.includes('mora>2'));
  assert('menciona CDC art. 52', bloco.includes('CDC'));
  assert('menciona 2%', bloco.includes('2%'));
}

grupo('[3] Lógica de aviso: juros > 1% a.m. dispara alerta');
{
  const bloco = extrairBlocoAvisos();
  assert('condição jrs>1 presente', bloco.includes('jrs>1'));
  assert('menciona 1% a.m.', bloco.includes('1%'));
}

grupo('[4] Lógica de aviso: cumulação mora + multa penal');
{
  const bloco = extrairBlocoAvisos();
  assert('condição mora>0&&penal>0 presente', bloco.includes('mora>0&&penal>0'));
  assert('menciona cumulação', bloco.toLowerCase().includes('cumula'));
}

grupo('[5] Validação bloqueante: desconto não pode superar original + encargos');
{
  const veStart = html.indexOf('function validarExportacao()');
  const veEnd   = html.indexOf('return{erros,avisos,html}', veStart);
  const corpo   = html.substring(veStart, veEnd);
  assert('descCts>origCts+encCts verificado', corpo.includes('descCts>origCts+encCts2'));
  assert('erro vai para secao 04', corpo.includes("'04'"));
}

grupo('[6] Campo e_multamora está em CAMPOS_FORMULARIO (persiste no JSON)');
{
  const cfStart = html.indexOf('const CAMPOS_FORMULARIO');
  const cfEnd   = html.indexOf(']);', cfStart);
  const cfBloco = html.substring(cfStart, cfEnd);
  assert('e_multamora persistido', cfBloco.includes("'e_multamora'"));
  assert('e_juros persistido',     cfBloco.includes("'e_juros'"));
  assert('e_multapenal persistido',cfBloco.includes("'e_multapenal'"));
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`Resultado: ${passou} ✓  ${falhou} ✗\n`);
if (falhou > 0) process.exit(1);
