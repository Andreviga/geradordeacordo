// tests/feriados.test.js — Fase D / P1.4: dias úteis com feriados
//
// Cópia das funções puras de index.html — manter sincronizadas.
// Execute: node tests/feriados.test.js

'use strict';

// ── Cópias de index.html (sincronizar) ───────────────────────────────────
const _pascoa = {};
function pascoa(ano) {
  if (_pascoa[ano]) return _pascoa[ano];
  const a=ano%19, b=Math.floor(ano/100), c=ano%100;
  const d=Math.floor(b/4), e=b%4, f=Math.floor((b+8)/25);
  const g=Math.floor((b-f+1)/3), h=(19*a+b-d-g+15)%30;
  const i=Math.floor(c/4), k=c%4, l=(32+2*e+2*i-h-k)%7;
  const m=Math.floor((a+11*h+22*l)/451);
  const mes=Math.floor((h+l-7*m+114)/31);
  const dia=((h+l-7*m+114)%31)+1;
  return (_pascoa[ano] = new Date(ano, mes-1, dia));
}
function addDias(d, n) { const r = new Date(d); r.setDate(r.getDate()+n); return r; }
const pad2  = n => String(n).padStart(2, '0');
const fmtMD  = d => pad2(d.getMonth()+1) + '-' + pad2(d.getDate());
const fmtAMD = d => d.getFullYear() + '-' + fmtMD(d);

const FERIADOS_FIXOS = new Set([
  '01-01','04-21','05-01','09-07','10-12','11-02','11-15','11-20','12-25',
  '07-09', '01-25',
]);

const _fmov = {};
function feriadosMoveis(ano) {
  if (_fmov[ano]) return _fmov[ano];
  const p = pascoa(ano);
  return (_fmov[ano] = new Set([
    fmtMD(addDias(p, -48)),
    fmtMD(addDias(p, -47)),
    fmtMD(addDias(p,  -2)),
    fmtMD(addDias(p,  60)),
  ]));
}

function parseFeriadosManuais(raw) {
  const set = new Set();
  if (!raw) return set;
  raw.split(/[\n,;]+/).forEach(s => {
    s = s.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { set.add(s); return; }
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
      const [dd, mm, aaaa] = s.split('/');
      set.add(`${aaaa}-${mm}-${dd}`);
    }
  });
  return set;
}

function eFeriado(data, ferManuais) {
  const md = fmtMD(data);
  if (FERIADOS_FIXOS.has(md)) return true;
  if (feriadosMoveis(data.getFullYear()).has(md)) return true;
  if (ferManuais && ferManuais.has(fmtAMD(data))) return true;
  return false;
}

// ── Utilidades ────────────────────────────────────────────────────────────
let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else       { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

// ── [1] Cálculo da Páscoa — datas conhecidas ──────────────────────────────
grupo('[1] Cálculo da Páscoa — datas verificadas');
{
  const casos = [
    [2024, 3, 31],  // 31/03/2024
    [2025, 4, 20],  // 20/04/2025
    [2026, 4,  5],  // 05/04/2026
    [2027, 3, 28],  // 28/03/2027
    [2028, 4, 16],  // 16/04/2028
  ];
  casos.forEach(([ano, mes, dia]) => {
    const p = pascoa(ano);
    assert(
      `Páscoa ${ano} = ${pad2(dia)}/${pad2(mes)}`,
      p.getFullYear()===ano && p.getMonth()===mes-1 && p.getDate()===dia
    );
  });
}

// ── [2] Feriados móveis 2025 (Páscoa 20/04) ────────────────────────────────
grupo('[2] Feriados móveis 2025 (Páscoa 20/04)');
{
  const fm = feriadosMoveis(2025);
  assert('Segunda de Carnaval: 03/03/2025', fm.has('03-03'));
  assert('Terça de Carnaval:   04/03/2025', fm.has('03-04'));
  assert('Sexta-feira Santa:   18/04/2025', fm.has('04-18'));
  assert('Corpus Christi:      19/06/2025', fm.has('06-19'));
}

// ── [3] Feriados móveis 2026 (Páscoa 05/04) ────────────────────────────────
grupo('[3] Feriados móveis 2026 (Páscoa 05/04)');
{
  const fm = feriadosMoveis(2026);
  assert('Segunda de Carnaval: 16/02/2026', fm.has('02-16'));
  assert('Terça de Carnaval:   17/02/2026', fm.has('02-17'));
  assert('Sexta-feira Santa:   03/04/2026', fm.has('04-03'));
  assert('Corpus Christi:      04/06/2026', fm.has('06-04'));
}

// ── [4] Feriados fixos nacionais + SP ─────────────────────────────────────
grupo('[4] Feriados fixos');
{
  const casos = [
    [2025, 0,  1, '01/01 — Confraternização'],
    [2025, 3, 21, '21/04 — Tiradentes'],
    [2025, 4,  1, '01/05 — Dia do Trabalho'],
    [2025, 8,  7, '07/09 — Independência'],
    [2025, 9, 12, '12/10 — Aparecida'],
    [2025,10,  2, '02/11 — Finados'],
    [2025,10, 15, '15/11 — República'],
    [2025,10, 20, '20/11 — Consciência Negra'],
    [2025,11, 25, '25/12 — Natal'],
    [2025, 6,  9, '09/07 — SP estadual'],
    [2025, 0, 25, '25/01 — SP capital'],
  ];
  casos.forEach(([ano, mes, dia, desc]) => {
    assert(desc, eFeriado(new Date(ano, mes, dia), null));
  });
}

// ── [5] Dias comuns não são feriados ──────────────────────────────────────
grupo('[5] Dias comuns não são feriados');
{
  assert('15/03/2025 não é feriado', !eFeriado(new Date(2025, 2, 15), null));
  assert('10/06/2025 não é feriado', !eFeriado(new Date(2025, 5, 10), null));
  assert('20/03/2025 não é feriado', !eFeriado(new Date(2025, 2, 20), null));
}

// ── [6] Feriados manuais ──────────────────────────────────────────────────
grupo('[6] Feriados manuais — formatos AAAA-MM-DD e DD/MM/AAAA');
{
  const manuais = parseFeriadosManuais('2025-12-24\n25/12/2025\n2025-07-14, 2025-12-31');
  assert('2025-12-24 (formato ISO)',     manuais.has('2025-12-24'));
  assert('25/12/2025 → 2025-12-25',     manuais.has('2025-12-25'));
  assert('2025-07-14 (via vírgula)',     manuais.has('2025-07-14'));
  assert('2025-12-31',                  manuais.has('2025-12-31'));
  assert('2025-12-24 reconhecido por eFeriado', eFeriado(new Date(2025, 11, 24), manuais));
  assert('2026-12-24 NÃO reconhecido (ano errado)', !eFeriado(new Date(2026, 11, 24), manuais));
}

// ── [7] Vencimento em feriado → prorroga para próximo dia útil ───────────
grupo('[7] Prorrogação de feriado para próximo dia útil');
{
  // 01/01/2026 (quinta-feira, Ano Novo) → deve prorrogar para 02/01/2026 (sexta)
  let d = new Date(2026, 0, 1);
  assert('01/01/2026 é feriado', eFeriado(d, null));
  while (d.getDay()===0 || d.getDay()===6 || eFeriado(d, null))
    d = addDias(d, 1);
  assert('Prorroga para 02/01/2026', fmtAMD(d)==='2026-01-02');
}

// ── [8] Sequência Carnaval → Sexta-feira Santa → volta ao normal ──────────
grupo('[8] Semana do Carnaval 2025 e Semana Santa — sem dia útil nos feriados');
{
  const fm25 = feriadosMoveis(2025);
  // Carnaval: 03/03 (seg) e 04/03 (ter) — 05/03 (quarta-cinzas) não é feriado oficial
  assert('03/03/2025 (seg Carnaval) é feriado',  fm25.has(fmtMD(new Date(2025, 2, 3))));
  assert('04/03/2025 (ter Carnaval) é feriado',  fm25.has(fmtMD(new Date(2025, 2, 4))));
  assert('05/03/2025 (qua-cinzas) NÃO é feriado', !fm25.has(fmtMD(new Date(2025, 2, 5))));
  assert('18/04/2025 (Sex Santa) é feriado',     fm25.has(fmtMD(new Date(2025, 3, 18))));
  assert('17/04/2025 (qui) NÃO é feriado móvel',  !fm25.has(fmtMD(new Date(2025, 3, 17))));
}

// ── Resultado ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(54)}`);
console.log(`Resultado: ${passou} ✓  ${falhou} ✗\n`);
if (falhou > 0) process.exit(1);
