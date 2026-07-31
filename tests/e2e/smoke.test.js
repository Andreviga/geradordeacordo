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

});
