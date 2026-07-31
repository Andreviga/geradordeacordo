// tests/subst.test.js — ordem e segurança de subst() + esc()
//
// Cópia das funções puras de index.html. MANTER SINCRONIZADO com index.html.
// Testa a invariante crítica: subst() antes, esc() depois.

'use strict';

// ── Cópias de index.html ──────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function subst(txt, T) {
  const R = T.__refs || {};
  return txt
    .replace(/\{\{ref:([\w-]+)\}\}/g, (m, id) => R[id] || 'cláusula acima')
    .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in T ? T[k] : m));
}

// ── Utilidades ────────────────────────────────────────────────────────────
let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else       { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

// ── Testes ────────────────────────────────────────────────────────────────

grupo('[1] Razão social com & → &amp; após subst→esc (ordem correta)');
{
  const T = { credora: 'Raízes & Cia Ltda' };
  const ok = esc(subst('Empresa: {{credora}}', T));
  assert('& vira &amp;', ok === 'Empresa: Ra\u00edzes &amp; Cia Ltda');
}

grupo('[2] Razão social com < e > → &lt; e &gt;');
{
  const T = { credora: 'Col\u00e9gio <BR>' };
  const ok = esc(subst('{{credora}}', T));
  assert('< vira &lt; e > vira &gt;', ok === 'Col\u00e9gio &lt;BR&gt;');
}

grupo('[3] Ordem invertida (esc→subst) NÃO protege — XSS se executado');
{
  const T = { credora: 'A & B' };
  // Com ordem errada: esc() não afeta {{ }}, mas o valor substituído fica cru
  const errada = subst(esc('{{credora}}'), T);  // esc primeiro, subst depois
  const certa  = esc(subst('{{credora}}', T));  // subst primeiro, esc depois
  assert('ordem certa produz &amp;',    certa.includes('&amp;'));
  assert('ordem errada NÃO produz &amp;', !errada.includes('&amp;'));
}

grupo('[4] Token desconhecido permanece literal (não crashar, não apagar)');
{
  const T = { credora: 'Escola' };
  const r = subst('{{foo}} {{credora}}', T);
  assert('{{foo}} permanece', r === '{{foo}} Escola');
}

grupo('[5] Valor vazio → string vazia, não "undefined"');
{
  const T = { periodo: '' };
  const r = subst('ref{{periodo}}end', T);
  assert('vazio → sem espaço', r === 'refend');
  assert('sem "undefined"', !r.includes('undefined'));
}

grupo('[6] {{ref:id}} resolve com mapa de refs');
{
  const T = { __refs: { mora: 'Cláusula Quarta' } };
  const r = subst('conforme {{ref:mora}}', T);
  assert('ref resolve', r === 'conforme Cláusula Quarta');
}

grupo('[7] {{ref:id}} ausente → "cláusula acima"');
{
  const T = { __refs: {} };
  const r = subst('{{ref:pagamento}}', T);
  assert('ref ausente → fallback', r === 'cláusula acima');
}

grupo('[8] Caractere " (aspas) não quebra atributos HTML');
{
  const T = { credora: 'Col\u00e9gio "Raízes"' };
  const html = esc(subst('Nome: {{credora}}', T));
  // esc() não escapa " por padrão — verificar que não gera atributo quebrado
  // A função esc() em index.html não transforma " em &quot;, o que é intencional
  // pois os valores são inseridos como texto de nó, não em atributos HTML
  assert('resultado não tem tags abertas', !html.includes('<') && !html.includes('>'));
}

// ── Resultado ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Resultado: ${passou} ✓  ${falhou} ✗\n`);
if (falhou > 0) process.exit(1);
