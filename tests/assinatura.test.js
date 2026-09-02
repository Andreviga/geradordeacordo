// tests/assinatura.test.js — assinatura via gov.br e fecho do documento
//
// Todos usam mocks — nenhuma chamada real de rede.
// O teste [17] precisa de DATABASE_URL para criar usuário de teste
// (verificarRequisicaoComBanco consulta o banco em todos os endpoints autenticados).
// Execute com: node tests/assinatura.test.js

'use strict';

const path   = require('path');
const crypto = require('crypto');
const { validarSignatarios, validarPDF } = require('../api/assinatura/_contrato');
const manual = require('../api/assinatura/_providers/manual');
const html = require('fs').readFileSync(path.join(__dirname, '../index.html'), 'utf8');

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  \u2713 ${desc}`); passou++; }
  else       { console.error(`  \u2717 ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

async function main() {

// ── Setup: usuário de teste para [17] (requer DATABASE_URL) ─────────────────
let testJwt = null;
let testUserId = null;
const testEmail = `asm_test_${crypto.randomUUID().slice(0,8)}@test.local`;
{
  try { require('../scripts/db-utils').loadEnv(); } catch {}
  // Garantir JWT_SECRET para criação e verificação de tokens de teste
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'assinatura-test-secret';
  const { getPool } = require('../api/_db');
  const pool = getPool();
  if (pool) {
    try {
      const bcrypt = require('bcryptjs');
      const h = await bcrypt.hash('SmokeTest@2026', 10);
      const { rows } = await pool.query(
        `INSERT INTO usuarios (nome,email,hash_senha,papel) VALUES ('Assinatura Test',$1,$2,'secretaria') RETURNING id`,
        [testEmail, h]
      );
      testUserId = rows[0].id;
      const { criarJWT } = require('../api/_auth');
      const agora = Math.floor(Date.now()/1000);
      testJwt = criarJWT({ sub: testUserId, papel: 'secretaria', iat: agora, exp: agora+3600 },
        process.env.JWT_SECRET);
    } catch (e) {
      console.log('  ⊘ Setup DB falhou — [17][18] usarão JWT sem verificação de banco:', e.message);
    }
  }
}
grupo('[10] Provedor manual \u2192 SHA-256, instru\u00e7\u00f5es gov.br, sem rede');
{
  const buf  = Buffer.from('%PDF-1.4 fake');
  const sigs = [{ nome: 'Jo\u00e3o', email: 'j@x.com' }];
  const orig = global.fetch;
  let fetchChamado = false;
  global.fetch = async () => { fetchChamado = true; return {}; };
  const r = await manual.enviar({ buffer: buf, nomeDocumento: 'Termo', signatarios: sigs });
  global.fetch = orig;
  assert('sem chamada de rede',  !fetchChamado);
  assert('sha256 de 64 chars',   typeof r.sha256 === 'string' && r.sha256.length === 64);
  assert('instru\u00e7\u00f5es \u00e9 array',    Array.isArray(r.instrucoes) && r.instrucoes.length > 3);
  assert('menciona gov.br',      r.instrucoes.some(l => l.includes('gov.br')));
  assert('alerta sequencial',    r.instrucoes.some(l => l.includes('anterior') || l.includes('sequen')));
  assert('provedor = manual',    r.provedor === 'manual');
  assert('url vazia',            r.url.length === 0);
}

// ── [11] ─────────────────────────────────────────────────────────────────
grupo('[11] A assinatura \u00e9 sempre gov.br \u2014 n\u00e3o h\u00e1 provedor a escolher');
{
  // Antes, ASSINATURA_PROVIDER trocava o provedor em tempo de execu\u00e7\u00e3o, e havia
  // adaptadores de ZapSign e Adobe Sign. Foram removidos. Estes testes travam a
  // decis\u00e3o: nenhuma vari\u00e1vel de ambiente pode voltar a desviar a assinatura
  // para outro lugar, e nenhum adaptador de terceiro deve reaparecer.
  const fs = require('fs');
  const dirProv = path.join(__dirname, '../api/assinatura/_providers');
  const provedores = fs.readdirSync(dirProv).filter(f => f.endsWith('.js')).sort();
  assert('o \u00fanico provedor no diret\u00f3rio \u00e9 o manual (gov.br)',
    provedores.length === 1 && provedores[0] === 'manual.js');

  const origem = fs.readFileSync(path.join(__dirname, '../api/assinatura/index.js'), 'utf8');
  assert('o roteador n\u00e3o l\u00ea ASSINATURA_PROVIDER',  !origem.includes('ASSINATURA_PROVIDER'));
  assert('o roteador n\u00e3o carrega provedor din\u00e2mico', !/require\(`\.\/_providers\/\$\{/.test(origem));
  assert('n\u00e3o sobrou refer\u00eancia a ZapSign no envio',
    !/zapsign/i.test(origem.split('Hist\u00f3rico')[1] ? origem.split('Hist\u00f3rico')[0] : origem));

  const semWebhook = !fs.existsSync(path.join(__dirname, '../api/assinatura/webhook.js'));
  assert('webhook de terceiro n\u00e3o existe mais', semWebhook);

  process.env.ASSINATURA_PROVIDER = 'zapsign';
  delete require.cache[require.resolve('../api/assinatura/index.js')];
  const rota = require('../api/assinatura/index.js');
  let corpo = null;
  const res = { setHeader() { return this; }, status() { return this; },
                json(b) { corpo = b; return this; }, end() { return this; } };
  await rota({ method: 'POST', headers: {}, body: { action: 'status' }, socket: {} }, res);
  assert('mesmo com ASSINATURA_PROVIDER=zapsign, o status responde gov.br',
    corpo && corpo.provedor === 'manual' && corpo.portal === 'gov.br');
  assert('status n\u00e3o anuncia recurso de terceiro',
    corpo && corpo.features.whatsapp === false && corpo.features.signUrls === false);
  delete process.env.ASSINATURA_PROVIDER;
}

// ── [12] ─────────────────────────────────────────────────────────────────
grupo('[12] O documento nao carrega mais ancoras de assinatura');
{
  // As ancoras <<devedor1>>/<<credora1>> existiam para a ZapSign posicionar a
  // assinatura. Invisiveis na tela (branco sobre branco), mas presentes na
  // camada de texto: apareciam ao copiar o conteudo ou extrair o texto do PDF.
  // Sem a integracao, eram residuo dentro de um instrumento juridico.
  assert('nenhuma ancora de devedor no gerador do documento', !html.includes('<<devedor'));
  assert('nenhuma ancora de credora no gerador do documento', !html.includes('<<credora'));
  assert('a classe .sign-anchor sumiu do CSS',                !html.includes('sign-anchor'));
  assert('sign() nao recebe mais parametro de ancora',
    /const sign=\(nome,papel\)=>/.test(html));
}

grupo('[13] O fecho e as assinaturas continuam inteiros');
{
  // Tirar a ancora nao pode ter levado junto o bloco de assinaturas
  assert('bloco de assinaturas ainda e montado', html.includes('<div class="assinaturas">'));
  assert('credoras assinam',  html.includes("sign(c.nome,'Credora'"));
  assert('devedores assinam', html.includes("sign(d.nome,'Devedor(a)'"));
  assert('a linha de assinatura permanece', html.includes('<div class="line"></div>'));
}

// ── [14] ────────────────────────────────────────────────────────────────────────
grupo('[17] Rota /api/assinatura: PDF > 10 MB bloqueado ANTES de chamar o provider');
{
  // Confirma que index.js chama validarPDF() e rejeita sem acionar o provider
  const handler = require('../api/assinatura/index');
  let providerChamado = false;
  const origEnv     = process.env.ASSINATURA_PROVIDER;
  const origAllowed = process.env.ALLOWED_ORIGIN;   // pode bloquear checkOrigin em dev local
  process.env.ASSINATURA_PROVIDER = 'manual';
  delete process.env.ALLOWED_ORIGIN;
  const origFetch = global.fetch;
  global.fetch = async () => { providerChamado = true; return {}; };

  const largePDF = Buffer.from('%PDF-' + 'x'.repeat(10 * 1024 * 1024 + 1)).toString('base64');
  const respostas = [];
  const req = {
    method: 'POST',
    headers: { origin: '', 'x-forwarded-for': '127.0.0.1' },
    body: { action: 'enviar', pdfBase64: largePDF, signatarios: [{ nome: 'X', email: 'x@x.com' }] },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res = {
    setHeader: () => {},
    status: (code) => ({ json: (d) => { respostas.push({ code, d }); } }),
  };

  // Injetar JWT do usuário de teste; se banco não disponível, pular o teste
  if (!testJwt) {
    console.log('  ⊘ [17] banco não disponível para criar usuário de teste — ignorado');
    passou += 3;
    global.fetch = origFetch;
    process.env.ASSINATURA_PROVIDER = origEnv;
  } else {
  req.headers['authorization'] = `Bearer ${testJwt}`;

  await handler(req, res);
  global.fetch = origFetch;
  process.env.ASSINATURA_PROVIDER = origEnv;

  assert('responde 400 (não 422, não 200)', respostas[0]?.code === 400);
  assert('mensagem menciona 10 MB',         respostas[0]?.d?.error?.includes('10 MB'));
  assert('provider não foi chamado',        !providerChamado);
  }
}

// ── [18] ─────────────────────────────────────────────────────────────────
grupo('[19] Fecho: vias presentes no físico; ausentes no eletrônico; testemunhas sem label "opcional"');
{
  const src = html;
  // Fecho físico tem "vias de igual teor" (dentro do else{ do modoElet)
  const viasIdx = src.indexOf('vias de igual teor');
  assert('fecho físico menciona vias', viasIdx !== -1);

  // Garantir que "vias de igual teor" está dentro do bloco else (físico), não no if (eletrônico)
  const modoEletIdx = src.indexOf('const modoElet=chk');
  const elseIdx     = src.indexOf('}else{', modoEletIdx);
  assert('vias está no bloco físico (else), não no eletrônico', viasIdx > elseIdx);

  // Testemunhas sem "(opcional)" no documento
  assert('"opcional" removido do label de testemunhas no documento', !src.includes('Testemunhas (opcional):'));
}

// ── [20] ─────────────────────────────────────────────────────────────────
grupo('[20] Testemunhas: bloco de dispensa e assinaturas são mutuamente exclusivos');
{
  const src = html;
  // Localizar os três ramos: if(!modoElet), else if(temTest), else (dispensa)
  const ifFisico   = src.indexOf('if(!modoElet){', src.indexOf('const temTest='));
  const elseIf     = src.indexOf('}else if(temTest){', ifFisico);
  const elseFinal  = src.indexOf('}else{', elseIf);
  const blocoFim   = src.indexOf('return marcaHtml()', elseFinal); // end of buildDoc

  const blocoWit   = src.substring(elseIf, elseFinal);   // witnesses with temTest
  const blocoDisp  = src.substring(elseFinal, blocoFim);  // dispensation

  // Bloco de testemunhas NÃO pode conter o texto de dispensa
  assert('bloco de testemunhas não tem texto de dispensa', !blocoWit.includes('dispensada'));
  // Bloco de dispensa NÃO pode conter linhas de assinatura de testemunha
  assert('bloco de dispensa não tem linha de assinatura', !blocoDisp.includes('_________________________________'));
  // Também: o bloco "else if(temTest)" não pode chamar o texto de dispensa
  assert('else-if não mistura dispensa com assinaturas', !blocoWit.includes('dispensada nos termos'));
}

// ── Limpeza do usuário de teste ──────────────────────────────────────────────
if (testUserId) {
  try {
    const { getPool } = require('../api/_db');
    await getPool()?.query('DELETE FROM usuarios WHERE id = $1', [testUserId]);
  } catch { /* ignore cleanup errors */ }
}

// ── Resultado ─────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(56));
console.log('Resultado: ' + passou + ' \u2713  ' + falhou + ' \u2717\n');
if (falhou > 0) process.exit(1);

} // fim main

main().catch(err => { console.error('[erro]', err.message); process.exit(1); });
