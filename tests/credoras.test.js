// tests/credoras.test.js — Fase D / P1.6: CNPJ, CPF e rateio de credoras
//
// Cópia das funções puras de index.html — manter sincronizadas.
// Execute: node tests/credoras.test.js

'use strict';

// ── Cópias de index.html ──────────────────────────────────────────────────
function validarCNPJ(cnpj) {
  const n = cnpj.replace(/\D/g, '');
  if (n.length !== 14 || /^(\d)\1{13}$/.test(n)) return false;
  let s = 0, w = 5;
  for (let i = 0; i < 12; i++) { s += parseInt(n[i]) * w; w--; if (w < 2) w = 9; }
  let dv = s % 11 < 2 ? 0 : 11 - (s % 11);
  if (dv !== parseInt(n[12])) return false;
  s = 0; w = 6;
  for (let i = 0; i < 13; i++) { s += parseInt(n[i]) * w; w--; if (w < 2) w = 9; }
  dv = s % 11 < 2 ? 0 : 11 - (s % 11);
  return dv === parseInt(n[13]);
}

function validarCPF(cpf) {
  const n = cpf.replace(/\D/g, '');
  if (n.length !== 11 || /^(\d)\1{10}$/.test(n)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += parseInt(n[i]) * (10 - i);
  let r = (s * 10) % 11;
  if (r === 10 || r === 11) r = 0;
  if (r !== parseInt(n[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += parseInt(n[i]) * (11 - i);
  r = (s * 10) % 11;
  if (r === 10 || r === 11) r = 0;
  return r === parseInt(n[10]);
}

function validarDocumento(doc, tipo) {
  const n = doc.replace(/\D/g, '');
  if (tipo === 'pj' || n.length === 14) return validarCNPJ(doc);
  if (tipo === 'pf' || n.length === 11) return validarCPF(doc);
  return false;
}

// ── Utilidades ────────────────────────────────────────────────────────────
let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else       { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

// ── [1] CNPJ válido ───────────────────────────────────────────────────────
grupo('[1] CNPJs válidos');
{
  assert('59.946.400/0001-37 (Raízes 1)', validarCNPJ('59.946.400/0001-37'));
  assert('20.755.729/0001-85 (Raízes 2)', validarCNPJ('20.755.729/0001-85'));
  assert('11.222.333/0001-81',            validarCNPJ('11222333000181'));
  assert('Dígitos sem formatação OK',      validarCNPJ('59946400000137'));
}

// ── [2] CNPJ inválido ─────────────────────────────────────────────────────
grupo('[2] CNPJs inválidos');
{
  assert('DV errado rejeitado',           !validarCNPJ('11.222.333/0001-99'));
  assert('Sequência repetida rejeitada',  !validarCNPJ('11.111.111/1111-11'));
  assert('Muito curto rejeitado',         !validarCNPJ('1234'));
  assert('Vazio rejeitado',               !validarCNPJ(''));
  assert('11.111.111/1111-11 rejeitado',  !validarCNPJ('11111111111111'));
}

// ── [3] CPF válido ────────────────────────────────────────────────────────
grupo('[3] CPFs válidos');
{
  assert('341.452.718-90 (devedor exemplo)', validarCPF('341.452.718-90'));
  assert('266.392.568-35 (devedor exemplo)', validarCPF('266.392.568-35'));
  assert('Dígitos sem formatação OK',        validarCPF('34145271890'));
}

// ── [4] CPF inválido ──────────────────────────────────────────────────────
grupo('[4] CPFs inválidos');
{
  assert('DV errado rejeitado',            !validarCPF('341.452.718-91'));
  assert('111.111.111-11 rejeitado',       !validarCPF('111.111.111-11'));
  assert('000.000.000-00 rejeitado',       !validarCPF('000.000.000-00'));
  assert('Muito curto rejeitado',          !validarCPF('123'));
}

// ── [5] validarDocumento — auto-detect por comprimento ───────────────────
grupo('[5] validarDocumento — roteamento por tipo');
{
  assert('pj → valida CNPJ (válido)',    validarDocumento('59.946.400/0001-37', 'pj'));
  assert('pj → valida CNPJ (inválido)', !validarDocumento('00.000.000/0000-00', 'pj'));
  assert('pf → valida CPF (válido)',     validarDocumento('341.452.718-90', 'pf'));
  assert('pf → valida CPF (inválido)',   !validarDocumento('341.452.718-91', 'pf'));
  assert('Auto 14 dígitos → CNPJ',       validarDocumento('59946400000137', 'pj'));
  assert('Auto 11 dígitos → CPF',        validarDocumento('34145271890', 'pf'));
}

// ── [6] Lógica de duplicidade de CNPJ entre credoras ─────────────────────
grupo('[6] CNPJs distintos entre credoras');
{
  function validarCredoras(lista) {
    const erros = [];
    const docs = new Set();
    lista.forEach((c, i) => {
      const lbl = 'Credora ' + (i+1);
      if (c.doc) {
        if (!validarDocumento(c.doc, c.tipo)) {
          erros.push(lbl + ': CNPJ/CPF inválido');
        } else {
          const limpo = c.doc.replace(/\D/g, '');
          if (docs.has(limpo)) erros.push(lbl + ': CNPJ/CPF duplicado');
          else docs.add(limpo);
        }
      }
    });
    return erros;
  }

  const c1 = { doc: '59.946.400/0001-37', tipo: 'pj', nome: 'Raízes 1' };
  const c2 = { doc: '20.755.729/0001-85', tipo: 'pj', nome: 'Raízes 2' };
  const cBad = { doc: '11.222.333/0001-99', tipo: 'pj', nome: 'CNPJ errado' };
  const cDup = { doc: '59.946.400/0001-37', tipo: 'pj', nome: 'Raízes 1 (dup)' };

  assert('Duas credoras distintas → sem erros',  validarCredoras([c1, c2]).length === 0);
  assert('CNPJ inválido detectado',              validarCredoras([c1, cBad]).some(e => e.includes('inválido')));
  assert('CNPJ duplicado detectado',             validarCredoras([c1, cDup]).some(e => e.includes('duplicado')));
  assert('Uma credora válida → sem erros',       validarCredoras([c1]).length === 0);
}

// ── [7] Rateio por parcela ────────────────────────────────────────────────
grupo('[7] Rateio proporcional por parcela');
{
  // Simula divisaoHtml para duas credoras com parcela conhecida
  function simRateio(credoras, parcelaCts) {
    const cv = credoras.filter(c => c.cts > 0);
    if (cv.length < 2) return [];
    const totalCts = cv.reduce((s, c) => s + c.cts, 0);
    return cv.map(c => {
      const pct = (c.cts / totalCts * 100).toFixed(2);
      const parcelaCredora = Math.round(parcelaCts * c.cts / totalCts);
      return { nome: c.nome, pct, parcelaCredora };
    });
  }

  const creds = [
    { nome: 'Raízes 1', cts: 600000 },  // R$ 6.000,00 (60%)
    { nome: 'Raízes 2', cts: 400000 },  // R$ 4.000,00 (40%)
  ];
  const parcela = 100000; // R$ 1.000,00
  const rateio = simRateio(creds, parcela);

  assert('Duas entradas retornadas', rateio.length === 2);
  assert('Raízes 1 = 60%', rateio[0].pct === '60.00');
  assert('Raízes 2 = 40%', rateio[1].pct === '40.00');
  assert('Parcela Raízes 1 = R$ 600,00 (60000 cts)', rateio[0].parcelaCredora === 60000);
  assert('Parcela Raízes 2 = R$ 400,00 (40000 cts)', rateio[1].parcelaCredora === 40000);
  assert('Soma das parcelas = parcela total', rateio[0].parcelaCredora + rateio[1].parcelaCredora === parcela);

  // Uma só credora → não deve exibir rateio
  const simples = simRateio([{ nome: 'Única', cts: 1000000 }], 100000);
  assert('Uma credora → sem rateio (array vazio)', simples.length === 0);
}

// ── Resultado ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
console.log(`Resultado: ${passou} ✓  ${falhou} ✗\n`);
if (falhou > 0) process.exit(1);
