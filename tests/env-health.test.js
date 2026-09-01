// tests/env-health.test.js — toda variável de ambiente lida em produção precisa
// aparecer no health.
//
// Por que este teste existe: DRIVE_BACKUP_FOLDER_ID nunca foi configurada no
// painel do Vercel. O backup semanal levantava, lançava
// "DRIVE_BACKUP_FOLDER_ID não configurado" antes de ler o banco, e morria — toda
// segunda, sem que nada aparecesse fora do log. Nenhum dos dois health checava a
// variável, então não havia como perceber.
//
// A regra aqui é simples e se mantém sozinha: se o código lê uma variável, ela
// tem de estar no inventário do health. Uma variável nova que ninguém declarou
// quebra este teste na hora, em vez de virar falha silenciosa meses depois.

'use strict';

const fs   = require('fs');
const path = require('path');

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else      { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

const raiz = path.join(__dirname, '..');

// Injetadas pelo próprio Vercel — não são configuração de ninguém
const INJETADAS = /^VERCEL_/;

function varrer(dir, achadas = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { varrer(p, achadas); continue; }
    if (!e.name.endsWith('.js')) continue;
    const src = fs.readFileSync(p, 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z_0-9]*)/g)) {
      const nome = m[1];
      if (INJETADAS.test(nome)) continue;
      if (!achadas.has(nome)) achadas.set(nome, []);
      const rel = path.relative(raiz, p).replace(/\\/g, '/');
      if (!achadas.get(nome).includes(rel)) achadas.get(nome).push(rel);
    }
  }
  return achadas;
}

// Só vale o que é código de verdade: comentário mencionando a variável não conta.
// A primeira versão deste teste passava com a variável removida do inventário,
// justamente porque o nome aparecia num comentário logo acima.
function semComentarios(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// O bloco `resultado.vars = { ... }` do endpoint — o inventário propriamente dito
function inventarioDoEndpoint() {
  const src = semComentarios(fs.readFileSync(path.join(raiz, 'api/health.js'), 'utf8'));
  const m = src.match(/resultado\.vars\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!m) throw new Error('não encontrei o bloco resultado.vars em api/health.js');
  return m[1];
}

grupo('[1] Toda variável lida em api/ está declarada no health');
{
  const lidas = varrer(path.join(raiz, 'api'));
  const inv   = inventarioDoEndpoint();
  const cli   = semComentarios(fs.readFileSync(path.join(raiz, 'scripts/health.js'), 'utf8'));

  const ausentes = [];
  for (const [nome, arquivos] of [...lidas].sort()) {
    // health.js lê a si mesmo; não precisa se declarar duas vezes
    const soNoHealth = arquivos.length === 1 && arquivos[0] === 'api/health.js';
    const declarada  = inv.includes(nome) || cli.includes(nome);
    if (!declarada && !soNoHealth) ausentes.push(`${nome} (lida em ${arquivos.join(', ')})`);
  }
  assert(`${lidas.size} variáveis lidas, todas no inventário do health`, ausentes.length === 0);
  ausentes.forEach(a => console.error(`      falta declarar: ${a}`));
}

grupo('[2] As que derrubam funcionalidade inteira são checadas de verdade');
{
  const inv = inventarioDoEndpoint();
  const cli = semComentarios(fs.readFileSync(path.join(raiz, 'scripts/health.js'), 'utf8'));

  // Cada uma destas faz um recurso inteiro parar, e de forma silenciosa
  const criticas = [
    ['DATABASE_URL',           'sem banco não há sistema'],
    ['JWT_SECRET',             'ninguém consegue entrar'],
    ['CRON_SECRET',            'lembretes e backup respondem 401 e nunca rodam'],
    ['DRIVE_BACKUP_FOLDER_ID', 'o backup semanal falha a cada execução'],
  ];
  for (const [nome, porque] of criticas) {
    assert(`${nome} está no inventário do /api/health — ${porque}`,
      new RegExp(`process\\.env\\.${nome}\\b`).test(inv));
    assert(`${nome} é checada pelo npm run health`,
      new RegExp(`['"\`]${nome}['"\`]|process\\.env\\.${nome}\\b`).test(cli));
  }

  // Faltar não pode ser só informativo: tem de derrubar o ok do health
  const src = semComentarios(fs.readFileSync(path.join(raiz, 'api/health.js'), 'utf8'));
  assert('faltar DRIVE_BACKUP_FOLDER_ID marca o health como não-ok',
    /!resultado\.vars\.DRIVE_BACKUP_FOLDER_ID[\s\S]{0,200}resultado\.ok\s*=\s*false/.test(src));
  assert('faltar CRON_SECRET marca o health como não-ok',
    /!resultado\.vars\.CRON_SECRET[\s\S]{0,200}resultado\.ok\s*=\s*false/.test(src));
}

grupo('[3] O backup declara a pasta que ele mesmo exige');
{
  const motor = fs.readFileSync(path.join(raiz, 'api/cron/_backup_engine.js'), 'utf8');
  assert('o motor de backup lança sem DRIVE_BACKUP_FOLDER_ID',
    /DRIVE_BACKUP_FOLDER_ID[\s\S]{0,120}throw/.test(motor));
}

console.log(`\nResultado: ${passou} ✓  ${falhou} ✗`);
if (falhou > 0) process.exit(1);
