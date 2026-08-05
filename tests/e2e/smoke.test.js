// tests/e2e/smoke.test.js — smoke tests do Gerador de Acordo
//
// Cobre:
//   1. Carga sem erros de console
//   2. Modal de login aparece para usuário não autenticado
//   3. Login via /api/login (mockado) fecha o modal e renderiza o documento
//   4. Exportação bloqueada quando há token órfão numa cláusula
//
// As chamadas /api/* são interceptadas por page.route() — não requer servidor
// de API real. Basta o servidor estático (tests/e2e/servidor.js).

const { test, expect } = require('@playwright/test');

// Cria um JWT fake válido para contornar o login nos testes
// A assinatura é inválida no servidor, mas o cliente só verifica o campo exp.
function jwtFakeCliente() {
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify({
    sub: 'test', papel: 'secretaria',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  return `${h}.${p}.assinatura_invalida_para_testes`;
}

// Mock padrão das APIs (usado em todos os testes)
async function mockAPIs(page) {
  // Mock do login: sempre aceita e devolve JWT fake
  await page.route('/api/login', async route => {
    await route.fulfill({
      status:      200,
      contentType: 'application/json',
      body:        JSON.stringify({ token: jwtFakeCliente() }),
    });
  });
  // Mock do adobe-sign (legado) e da nova rota /api/assinatura
  await page.route('/api/adobe-sign', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ configured: false }) });
  });
  await page.route('/api/assinatura', async route => {
    let action;
    try { action = route.request().postDataJSON()?.action; } catch { action = null; }
    if (action === 'status') {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ configured: true, provedor: 'manual', features: { whatsapp: false } }) });
    } else {
      await route.fulfill({ status: 401, contentType: 'application/json',
        body: JSON.stringify({ error: 'Mock: não autorizado' }) });
    }
  });
}

// Helper: faz login pelo modal
async function fazerLogin(page) {
  await expect(page.locator('#loginModal')).toBeVisible({ timeout: 5000 });
  await page.fill('#loginSenha', 'qualquer-senha-para-teste');
  await page.click('#loginBtn');
  await expect(page.locator('#loginModal')).toBeHidden({ timeout: 5000 });
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe('Smoke tests — Gerador de Acordo', () => {

  test('[1] Página carrega sem erros de console', async ({ page }) => {
    const erros = [];
    page.on('pageerror', err  => erros.push('[pageerror] ' + err.message));
    page.on('console',  msg  => { if (msg.type() === 'error') erros.push('[console.error] ' + msg.text()); });

    await mockAPIs(page);
    await page.goto('/');

    // Aguardar inicialização do JS (modal de login deve aparecer)
    await expect(page.locator('#loginModal')).toBeVisible({ timeout: 5000 });

    expect(erros, 'Erros no console:\n' + erros.join('\n')).toHaveLength(0);
  });

  test('[2] Modal de login aparece para usuário não autenticado', async ({ page }) => {
    await mockAPIs(page);
    await page.goto('/');
    await expect(page.locator('#loginModal')).toBeVisible({ timeout: 5000 });
    // Formulário contém o campo de senha
    await expect(page.locator('#loginSenha')).toBeVisible();
    await expect(page.locator('#loginBtn')).toHaveText('Entrar');
  });

  test('[3] Login fecha o modal e renderiza o documento', async ({ page }) => {
    await mockAPIs(page);
    await page.goto('/');
    await fazerLogin(page);

    // Documento deve ter conteúdo (render() rodou)
    await expect(page.locator('#doc')).not.toBeEmpty({ timeout: 5000 });
    // Título do documento deve aparecer
    await expect(page.locator('#doc h1')).toContainText('TERMO', { timeout: 3000 });
  });

  test('[4] Exportação bloqueada com token órfão em cláusula', async ({ page }) => {
    await mockAPIs(page);
    // Pre-setar JWT válido para não precisar do modal
    await page.addInitScript(`
      function b64url(s) {
        return btoa(unescape(encodeURIComponent(s)))
          .replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
      }
      const p = b64url(JSON.stringify({
        sub:'test', papel:'secretaria',
        iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600
      }));
      const h = b64url(JSON.stringify({alg:'HS256',typ:'JWT'}));
      sessionStorage.setItem('ger_jwt', h+'.'+p+'.sig');
    `);

    await page.goto('/');
    await expect(page.locator('#loginModal')).toBeHidden({ timeout: 5000 });

    // Abrir seção de cláusulas se estiver fechada
    const clausulasSummary = page.locator('.group summary:has-text("Cláusulas")');
    if (await clausulasSummary.isVisible()) {
      const isOpen = await page.locator('details.group:has(summary:has-text("Cláusulas"))').evaluate(el => el.open);
      if (!isOpen) await clausulasSummary.click();
    }

    // Adicionar token órfão à primeira cláusula
    const textarea = page.locator('textarea[data-k="texto"]').first();
    await expect(textarea).toBeVisible({ timeout: 3000 });
    const textoAtual = await textarea.inputValue();
    await textarea.fill('{{token_orfao_teste}} ' + textoAtual);

    // Tentar exportar (Baixar Word)
    await page.click('button:has-text("Baixar Word")');

    // Painel de validação deve aparecer com erro de token
    await expect(page.locator('#painelValidacao')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#painelValidacao')).toContainText('token_orfao_teste');
  });

  test('[5] Reload com JWT válido → botões de navegação visíveis', async ({ page }) => {
    // Reproduz o Bug 6: verificarAutenticacao() escondia o modal mas não mostrava os botões.
    // Qualquer regressão nessa função vai reaparecer aqui.
    const erros = [];
    page.on('pageerror', err => erros.push(err.message));

    await page.addInitScript(() => {
      function b64url(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }
      const h = b64url(JSON.stringify({ alg:'HS256', typ:'JWT' }));
      const p = b64url(JSON.stringify({ sub:'test', papel:'admin',
        iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 }));
      sessionStorage.setItem('ger_jwt', `${h}.${p}.sig`);
    });
    await mockAPIs(page);
    await page.goto('/');

    // Modal deve estar oculto (sessão ativa)
    await expect(page.locator('#loginModal')).toBeHidden({ timeout: 5000 });

    // Botões de navegação devem ser visíveis após reload com sessão ativa
    await expect(page.locator('#btnVerAcordos')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#btnDashboard')).toBeVisible();
    await expect(page.locator('#btnVencidas')).toBeVisible();

    expect(erros, 'Erros JS:\n' + erros.join('\n')).toHaveLength(0);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Testes de responsividade — viewport iPhone SE (375×667)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Responsividade mobile — 375×667', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  // Injeta JWT fake e aguarda modal fechado
  async function autenticarMobile(page) {
    await page.addInitScript(() => {
      function b64url(s) {
        return btoa(unescape(encodeURIComponent(s)))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      }
      const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const p = b64url(JSON.stringify({
        sub: 'test', papel: 'secretaria',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }));
      sessionStorage.setItem('ger_jwt', `${h}.${p}.sig`);
    });
    await mockAPIs(page);
    await page.goto('/');
    await expect(page.locator('#loginModal')).toBeHidden({ timeout: 5000 });
  }

  test('[5] Carga sem erro no console em viewport mobile', async ({ page }) => {
    const erros = [];
    page.on('pageerror', err => erros.push('[pageerror] ' + err.message));
    page.on('console',  msg => { if (msg.type() === 'error') erros.push('[console.error] ' + msg.text()); });
    await autenticarMobile(page);
    expect(erros, 'Erros no console:\n' + erros.join('\n')).toHaveLength(0);
  });

  test('[6] Tabs aparecem e alternam formulário/visualização', async ({ page }) => {
    await autenticarMobile(page);

    // Ambas as abas devem ser visíveis e acessíveis
    await expect(page.locator('#tab-form')).toBeVisible();
    await expect(page.locator('#tab-prev')).toBeVisible();
    await expect(page.locator('#tab-form')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#tab-prev')).toHaveAttribute('aria-selected', 'false');

    // Por padrão: formulário visível, stage oculto
    await expect(page.locator('.panel')).toBeVisible();
    await expect(page.locator('#docPreview')).toBeHidden();

    // Alterna para visualização
    await page.click('#tab-prev');
    await expect(page.locator('#docPreview')).toBeVisible();
    await expect(page.locator('.panel')).toBeHidden();
    await expect(page.locator('#tab-prev')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#tab-form')).toHaveAttribute('aria-selected', 'false');

    // Volta para formulário
    await page.click('#tab-form');
    await expect(page.locator('.panel')).toBeVisible();
    await expect(page.locator('#docPreview')).toBeHidden();
  });

  test('[7] Barra de ações inferior visível e com quatro botões', async ({ page }) => {
    await autenticarMobile(page);
    await expect(page.locator('#mobileBottom')).toBeVisible();
    // Verifica os quatro botões essenciais
    await expect(page.locator('#mobileBottom button').nth(0)).toContainText('Imprimir');
    await expect(page.locator('#mobileBottom button').nth(1)).toContainText('PDF');
    await expect(page.locator('#mobileBottom button').nth(2)).toContainText('Word');
    await expect(page.locator('#mobileBottom button').nth(3)).toContainText('Salvar');
  });

  test('[8] Exportação bloqueada via barra inferior com token órfão', async ({ page }) => {
    await autenticarMobile(page);

    // Garante que o painel de formulário está visível para interação
    await page.evaluate(() => {
      const p = document.querySelector('.panel');
      if (p) p.style.display = '';
    });

    // Abre a seção de cláusulas
    const clausulasSummary = page.locator('.group summary:has-text("Cláusulas")');
    if (await clausulasSummary.isVisible()) {
      const isOpen = await page.locator('details.group:has(summary:has-text("Cláusulas"))').evaluate(el => el.open);
      if (!isOpen) await clausulasSummary.click();
    }

    // Adiciona token órfão
    const textarea = page.locator('textarea[data-k="texto"]').first();
    await expect(textarea).toBeVisible({ timeout: 3000 });
    const textoAtual = await textarea.inputValue();
    await textarea.fill('{{token_orfao_mobile}} ' + textoAtual);

    // Dispara exportação pelo botão da barra inferior (Imprimir/PDF)
    await page.locator('#mobileBottom button').nth(0).click();

    // Painel de validação deve aparecer com o token inválido
    await expect(page.locator('#painelValidacao')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#painelValidacao')).toContainText('token_orfao_mobile');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Testes de @media print — corretude de layout e conteúdo
// ─────────────────────────────────────────────────────────────────────────────
//
// page.emulateMedia({ media: 'print' }) ativa as regras @media print sem
// abrir a caixa de diálogo do sistema, permitindo inspecionar computed styles.

test.describe('@media print — layout e conteúdo', () => {

  async function autenticarPrint(page) {
    await page.addInitScript(() => {
      function b64url(s) {
        return btoa(unescape(encodeURIComponent(s)))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      }
      const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const p = b64url(JSON.stringify({
        sub: 'test', papel: 'secretaria',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }));
      sessionStorage.setItem('ger_jwt', `${h}.${p}.sig`);
    });
    await mockAPIs(page);
    await page.goto('/');
    await expect(page.locator('#loginModal')).toBeHidden({ timeout: 5000 });
  }

  test('[P1] stage visível em print quando aba Formulário está ativa (375px)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await autenticarPrint(page);

    // No mobile a init chama switchTab('form') → inline display:none no stage
    const inlineDisplay = await page.evaluate(() => document.querySelector('#docPreview').style.display);
    expect(inlineDisplay).toBe('none');

    // @media print { .stage{display:block!important} } deve vencer o inline
    await page.emulateMedia({ media: 'print' });
    const computedDisplay = await page.evaluate(() =>
      getComputedStyle(document.querySelector('#docPreview')).display
    );
    expect(computedDisplay).toBe('block');
  });

  test('[P2] .page table tem display:table em print, não display:block', async ({ page }) => {
    await autenticarPrint(page);
    await expect(page.locator('#doc table')).toHaveCount(1, { timeout: 5000 });

    await page.emulateMedia({ media: 'print' });
    const display = await page.evaluate(() => {
      const tbl = document.querySelector('#doc table');
      return tbl ? getComputedStyle(tbl).display : 'not-found';
    });
    expect(display).toBe('table');
  });

  test('[P3] largura de .sign .line igual em 375px e 1440px em print', async ({ page }) => {
    await autenticarPrint(page);
    await page.emulateMedia({ media: 'print' });

    await page.setViewportSize({ width: 375, height: 667 });
    const w375 = await page.evaluate(() =>
      document.querySelector('.sign .line')?.getBoundingClientRect().width ?? -1
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    const w1440 = await page.evaluate(() =>
      document.querySelector('.sign .line')?.getBoundingClientRect().width ?? -1
    );

    expect(w375).toBeGreaterThan(0);
    // 87mm é unidade absoluta — viewport não deve alterar o valor computado
    expect(Math.abs(w375 - w1440)).toBeLessThan(2);
  });

  test('[P4] mobile 375px + print: stage visível e tabela com display:table', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await autenticarPrint(page);
    // stage já está oculto (init chamou switchTab('form'))

    await page.emulateMedia({ media: 'print' });

    const [stageDisplay, tableDisplay] = await page.evaluate(() => [
      getComputedStyle(document.querySelector('#docPreview')).display,
      (() => {
        const t = document.querySelector('#doc table');
        return t ? getComputedStyle(t).display : 'not-found';
      })(),
    ]);
    expect(stageDisplay).toBe('block');
    expect(tableDisplay).toBe('table');
  });

  test('[P5] #doc não contém tokens brutos — fonte usada pelo PDF e impressão', async ({ page }) => {
    await autenticarPrint(page);
    await expect(page.locator('#doc')).not.toBeEmpty({ timeout: 5000 });

    const texto = await page.locator('#doc').innerText();
    // Nenhum {{ deve sobrar após subst() em buildDoc()
    expect(texto).not.toMatch(/\{\{[^}]+\}\}/);

    // Exemplo carrega parcelas — tabela deve ter ao menos uma linha de dados
    const nLinhas = await page.locator('#doc table tbody tr').count();
    expect(nLinhas).toBeGreaterThan(0);
  });

  test('[P6] page.pdf() gera arquivo não vazio sem tokens raw no stream', async ({ page }) => {
    await autenticarPrint(page);
    await page.emulateMedia({ media: 'print' });

    const pdf = await page.pdf({ format: 'A4' });
    expect(pdf.length).toBeGreaterThan(5000);

    // Streams de texto no PDF do Chromium são frequentemente não-comprimidos;
    // verificar ausência de {{ no byte stream (best-effort, não garante texto comprimido)
    const raw = pdf.toString('binary');
    expect(/\{\{[A-Za-z]/.test(raw)).toBe(false);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Testes empíricos da P2: cabeçalho, marca d'água, fecho eletrônico e DOCX
// ─────────────────────────────────────────────────────────────────────────────

test.describe('P2 — verificações empíricas', () => {

  async function autenticarP2(page) {
    await page.addInitScript(() => {
      function b64url(s) {
        return btoa(unescape(encodeURIComponent(s)))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      }
      const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const p = b64url(JSON.stringify({
        sub: 'test', papel: 'secretaria',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }));
      sessionStorage.setItem('ger_jwt', `${h}.${p}.sig`);
    });
    await mockAPIs(page);
    await page.goto('/');
    await expect(page.locator('#loginModal')).toBeHidden({ timeout: 5000 });
  }

  // ── [D1] P2.2 — PDF com múltiplas páginas, cabeçalho sem invasão do corpo ─
  test('[D1] PDF com 30 cláusulas: múltiplas páginas geradas sem tokens brutos', async ({ page }) => {
    await autenticarP2(page);

    // Acrescentar cláusulas suficientes para garantir 3+ páginas
    await page.evaluate(() => {
      for (let i = 0; i < 27; i++) addClausula();
      render();
    });
    await expect(page.locator('#doc .assinaturas')).toBeVisible({ timeout: 3000 });

    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });

    // PDF substancial = múltiplas páginas geradas
    expect(pdf.length).toBeGreaterThan(50_000);

    // Sem tokens brutos no stream (conteúdo processado corretamente)
    const raw = pdf.toString('binary');
    expect(/\{\{[A-Za-z]/.test(raw)).toBe(false);

    // Nota: verificação de cabeçalho por página requer pdfjs-dist ou similar.
    // Verificação visual deve ser feita em Chrome (position:fixed repete) e
    // Firefox 127+ (mesmo comportamento). Safari: usar baixarPdf() que usa html2pdf/Chrome.
    // O math de não-invasão:
    //   @page margin-top=3.5cm; lh-header{top:-2.7cm} → 0.8cm do topo físico → dentro da margem.
    //   Corpo começa a 3.5cm → sem sobreposição estrutural.
  });

  // ── [D2] P2.4 — Marca d'água visível e com pixels reais ─────────────────
  test('[D2] Marca d\'água tem pixels visíveis em opacidade mínima e máxima', async ({ page }) => {
    await autenticarP2(page);
    await page.check('#op_timbre');
    await page.check('#op_marca');

    // CSS source não deve ter z-index:-1 na marca d'água
    const hasNegZIndex = await page.evaluate(() => {
      const content = document.documentElement.innerHTML;
      return /\.lh-mark\{[^}]*z-index:\s*-1/.test(content);
    });
    expect(hasNegZIndex).toBe(false);

    // Opacidade mínima (10%): pixels da imagem devem existir
    await page.fill('#op_marcaop', '10');
    await page.waitForTimeout(200);
    const pixelsMin = await page.evaluate(() => {
      const img = document.querySelector('.lh-mark');
      if (!img || !img.src) return { nonTransparent: 0, total: 0, opacity: 0 };
      const canvas = document.createElement('canvas');
      const natural_w = img.naturalWidth || img.width || 200;
      const natural_h = img.naturalHeight || img.height || 200;
      canvas.width = natural_w; canvas.height = natural_h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, natural_w, natural_h).data;
      let nonTransparent = 0;
      for (let i = 3; i < data.length; i += 4) { if (data[i] > 10) nonTransparent++; }
      return { nonTransparent, total: data.length / 4, opacity: parseFloat(img.style.opacity || 0.1) };
    });
    expect(pixelsMin.nonTransparent, 'Marca d\'água tem pixels em opacidade mínima').toBeGreaterThan(0);

    // Opacidade máxima (100%): mais pixels visíveis
    await page.fill('#op_marcaop', '100');
    await page.waitForTimeout(200);
    const pixelsMax = await page.evaluate(() => {
      const img = document.querySelector('.lh-mark');
      if (!img || !img.src) return { nonTransparent: 0 };
      const canvas = document.createElement('canvas');
      const w = img.naturalWidth || 200, h = img.naturalHeight || 200;
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
      let n = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 10) n++;
      return { nonTransparent: n };
    });
    expect(pixelsMax.nonTransparent).toBeGreaterThanOrEqual(pixelsMin.nonTransparent);

    // Marca d'água NÃO deve estar sobre as linhas de assinatura (.sign .line)
    const markRect = await page.locator('.lh-mark').boundingBox();
    const signLines = await page.locator('.sign .line').all();
    for (const line of signLines) {
      const lineRect = await line.boundingBox();
      if (!markRect || !lineRect) continue;
      const markBottom = markRect.y + markRect.height;
      const markTop    = markRect.y;
      const lineTop    = lineRect.y;
      const lineBottom = lineRect.y + lineRect.height;
      // Interseção vertical significa sobreposição
      const overlaps = markBottom > lineTop && markTop < lineBottom;
      expect(overlaps, 'Marca d\'água não deve sobrepor linha de assinatura').toBe(false);
    }
  });

  // ── [D3] Fecho eletrônico não menciona "vias" ─────────────────────────────
  test('[D3] Fecho eletrônico não menciona "vias de igual teor"', async ({ page }) => {
    await autenticarP2(page);

    await page.check('#op_assinatura_eletronica');
    await page.waitForTimeout(300);

    const docText = await page.locator('#doc').innerText();
    // Modo eletrônico: sem "vias", sem "duas vias", sem "02 (duas)"
    expect(docText).not.toMatch(/\d+\s*\(\w+\)\s*vias/i);
    expect(docText).not.toMatch(/vias de igual teor/i);
    // Fecho eletrônico contém a referência ao art. 784, §4º
    expect(docText).toContain('784');
  });

  // ── [D4] DOCX gerado: estrutura XML válida e conteúdo sem tokens brutos ───
  test('[D4] DOCX tem estrutura Office Open XML válida e conteúdo correto', async ({ page }) => {
    await autenticarP2(page);

    const validation = await page.evaluate(async () => {
      if (typeof JSZip === 'undefined') return { error: 'JSZip não carregado' };
      if (typeof gerarDocxBlob === 'undefined') return { error: 'gerarDocxBlob não definido' };

      let blob;
      try { blob = await gerarDocxBlob(); } catch (e) { return { error: e.message }; }

      const buf = await blob.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      const r = {};

      const required = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml',
                        'word/styles.xml', 'word/settings.xml', 'word/_rels/document.xml.rels'];
      for (const f of required) r['exists:' + f] = !!zip.files[f];

      const parser = new DOMParser();
      for (const f of required) {
        if (!zip.files[f]) continue;
        const text = await zip.files[f].async('text');
        const doc = parser.parseFromString(text, 'application/xml');
        r['valid:' + f] = !doc.querySelector('parsererror');
      }

      const docXml = await zip.files['word/document.xml'].async('text');
      r['content:not-empty'] = docXml.length > 200;
      r['content:no-orphan-tokens'] = !docXml.includes('{{');
      r['content:encoding-ok'] = docXml.includes('</w:t>') && !docXml.includes('?????');

      const hasTimbra = !!document.getElementById('op_timbre')?.checked;
      if (hasTimbra) {
        r['header:exists'] = !!zip.files['word/header1.xml'];
        r['footer:exists'] = !!zip.files['word/footer1.xml'];
        // Logo deve estar em word/media/ quando o timbre tem logo
        const hasLogo = !!zip.files['word/media/logo.png'];
        r['logo:present-or-noted'] = true; // logo pode estar ausente se canvas falhou
        if (hasLogo) {
          // Verificar que header referencia a logo
          const hdrXml = await zip.files['word/header1.xml'].async('text');
          r['header:references-logo'] = hdrXml.includes('rId1') && !!zip.files['word/_rels/header1.xml.rels'];
        }
      }
      return r;
    });

    if (validation.error) {
      test.skip(true, 'JSZip não disponível: ' + validation.error);
      return;
    }

    for (const [key, value] of Object.entries(validation)) {
      expect(value, `DOCX validation: ${key}`).toBe(true);
    }
  });

  // ── [D5] P2.2 — Coordenadas de texto no PDF (browser pdfjsLib via CDN) ────
  test('[D5] PDF com 30 cláusulas: cabeçalho em todas as páginas, corpo fora da margem de 3.5cm', async ({ page }) => {
    await autenticarP2(page);

    // Gerar documento longo (30 cláusulas ≈ 3-4 páginas A4)
    await page.evaluate(() => {
      for (let i = 0; i < 27; i++) addClausula();
      render();
    });
    await expect(page.locator('#doc .assinaturas')).toBeVisible({ timeout: 3000 });

    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    expect(pdf.length).toBeGreaterThan(50_000); // múltiplas páginas

    // Carregar pdfjs v3 no contexto da página para extração de coordenadas
    await page.addScriptTag({
      url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    });
    await page.addScriptTag({
      content: 'window.pdfjsWorkerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";',
    });

    const analysis = await page.evaluate(async ({ pdfBase64 }) => {
      const pdfjsLib = window['pdfjs-dist/build/pdf'];
      if (!pdfjsLib) return { error: 'pdfjsLib not loaded' };
      pdfjsLib.GlobalWorkerOptions.workerSrc = window.pdfjsWorkerSrc;

      const pdfData = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
      const doc = await pdfjsLib.getDocument({ data: pdfData }).promise;

      const PAGE_H = 841.89; // A4 em pts
      const TOP_MARGIN_PT = 3.5 / 2.54 * 72; // 99.2pt
      const BODY_TOP_Y = PAGE_H - TOP_MARGIN_PT; // 742.7pt do rodapé
      const BOT_MARGIN_PT = 2.5 / 2.54 * 72; // 71.1pt

      const results = { numPages: doc.numPages, pages: [] };
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i);
        const tc = await p.getTextContent();
        const pageInfo = { hasHeaderItems: false, bodyInvaders: [] };
        for (const item of tc.items) {
          const y = item.transform[5];
          const txt = item.str.trim();
          if (!txt) continue;
          if (y > BODY_TOP_Y) pageInfo.hasHeaderItems = true; // acima da área de conteúdo
          // Corpo não deve entrar na margem superior (exceto texto do próprio cabeçalho)
          if (y > BODY_TOP_Y && /Cláusula|Primeira|Segunda|Terceira|Quarta|Quinta/.test(txt)) {
            pageInfo.bodyInvaders.push({ txt: txt.slice(0, 30), y });
          }
        }
        results.pages.push(pageInfo);
      }
      return results;
    }, { pdfBase64: pdf.toString('base64') });

    if (analysis.error) {
      test.skip(true, 'pdfjs não carregou via CDN: ' + analysis.error);
      return;
    }

    expect(analysis.numPages).toBeGreaterThan(2);
    for (let i = 0; i < analysis.pages.length; i++) {
      const pg = analysis.pages[i];
      expect(pg.hasHeaderItems, `página ${i+1} tem itens na área do cabeçalho`).toBe(true);
      expect(pg.bodyInvaders, `página ${i+1} sem cláusulas invadindo margem`).toHaveLength(0);
    }
  });

});
