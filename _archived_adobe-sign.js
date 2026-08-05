// api/adobe-sign.js — Vercel Serverless Function
// Proxy seguro para Adobe Acrobat Sign REST API.
// As credenciais vivem APENAS em variáveis de ambiente do servidor (nunca no cliente).
//
// Variáveis de ambiente obrigatórias (configure no painel do Vercel):
//   ADOBE_SIGN_INTEGRATION_KEY  — chave de integração da conta Adobe Sign
//   ADOBE_SIGN_REGION           — região da conta (padrão: na4)
//                                 Valores válidos: na1 na2 na4 eu1 eu2 au1 jp1 in1
//
// Variável opcional:
//   ALLOWED_ORIGIN  — URL(s) de origem permitida, separadas por vírgula.
//                     Exemplo: https://geradordeacordo.vercel.app
//                     Se vazia, a verificação de origem é desabilitada (útil em dev).

'use strict';
const { verificarRequisicao } = require('./_auth');

// ── Rate limiting simples em memória ─────────────────────────────────────
const rateLimits = new Map();
const RATE_WINDOW_MS = 60_000; // 1 minuto
const RATE_MAX       = 10;     // máximo por janela por IP

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
  }
  entry.count++;
  rateLimits.set(ip, entry);
  return entry.count <= RATE_MAX;
}

// ── Verificação de origem ─────────────────────────────────────────────────
function checkOrigin(req) {
  const allowed = (process.env.ALLOWED_ORIGIN || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  const origin  = req.headers['origin']  || '';
  const referer = req.headers['referer'] || '';
  return allowed.some(a => origin.startsWith(a) || referer.startsWith(a));
}

// ── Tradução de códigos de erro da API Adobe Sign ─────────────────────────
function traduzirErro(data) {
  const MSGS = {
    INVALID_ACCESS_TOKEN:      'Integration Key inválida ou expirada (ADOBE_SIGN_INTEGRATION_KEY).',
    INVALID_USER:              'Usuário não encontrado na conta Adobe Sign.',
    USER_NOT_ACTIVE:           'Conta Adobe Sign inativa.',
    AGREEMENT_NOT_MODIFIABLE:  'O acordo não pode ser modificado no estado atual.',
    INVALID_PARTICIPANT:       'E-mail de signatário inválido ou não aceito pelo Adobe Sign.',
    DUPLICATE_PARTICIPANT:     'E-mail duplicado na lista de signatários.',
    MISSING_REQUIRED_PARAM:    'Parâmetro obrigatório ausente na requisição.',
    NO_FILE_CONTENT:           'Arquivo enviado está vazio.',
    REQUEST_LIMIT_EXCEEDED:    'Limite de requisições da API Adobe Sign atingido. Aguarde e tente novamente.',
    PLAN_LIMIT_EXCEEDED:       'Cota mensal do plano Adobe Sign esgotada. Aguarde o próximo ciclo ou faça upgrade do plano.',
  };
  const code = data.code || '';
  const msg  = MSGS[code]
    || (code ? `[${code}] ${(data.message || data.error || '').trim()}` : data.message || data.error || 'Erro desconhecido na API Adobe Sign.');
  return { error: msg, code };
}

module.exports = async function handler(req, res) {
  // Cabeçalhos CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Método não permitido.' });

  // Rate limiting por IP — cobre action=status também (prevenção de sondagem)
  const ip = ((req.headers['x-forwarded-for'] || '') || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Muitas requisições. Aguarde um minuto e tente novamente.' });
  }

  const { action, ...params } = req.body || {};
  if (!action) return res.status(400).json({ error: 'Parâmetro "action" obrigatório.' });

  // ── action: status — isento de auth, coberto por rate limit ────────────
  // Retorna apenas { configured: true|false }. Nenhuma credencial exposta.
  // A UI precisa chamar isto na carga da página sem ter nenhum token configurado.
  if (action === 'status') {
    return res.status(200).json({
      configured: !!(process.env.ADOBE_SIGN_INTEGRATION_KEY),
    });
  }

  // JWT obrigatório para todas as ações autenticadas
  const usuario = verificarRequisicao(req, res);
  if (!usuario) return;

  // Camada 2: Verificar origem (ALLOWED_ORIGIN). Header é falsificável por
  // clientes não-browser, por isso é camada adicional, não única.
  if (!checkOrigin(req)) {
    return res.status(403).json({ error: 'Origem não autorizada.' });
  }

  // Credenciais do servidor
  const KEY    = process.env.ADOBE_SIGN_INTEGRATION_KEY;
  const REGION = (process.env.ADOBE_SIGN_REGION || 'na4').toLowerCase();

  if (!KEY) {
    return res.status(503).json({
      error: 'Adobe Acrobat Sign não configurado neste ambiente. '
           + 'Configure ADOBE_SIGN_INTEGRATION_KEY no painel do Vercel.',
    });
  }

  const REGIOES_VALIDAS = ['na1','na2','na4','eu1','eu2','au1','jp1','in1'];
  if (!REGIOES_VALIDAS.includes(REGION)) {
    return res.status(500).json({
      error: `Região inválida na configuração do servidor: "${REGION}". `
           + `Valores aceitos: ${REGIOES_VALIDAS.join(', ')}.`,
    });
  }

  const BASE        = `https://api.${REGION}.adobesign.com/api/rest/v6`;
  const authHeaders = { Authorization: `Bearer ${KEY}` };

  try {
    // ── action: upload ─ documento transitório ─────────────────────────
    if (action === 'upload') {
      const { filename, content, mimeType = 'text/html' } = params;
      if (!filename || content === undefined) {
        return res.status(400).json({ error: 'Parâmetros obrigatórios: filename, content.' });
      }
      if (!content) {
        return res.status(400).json({ error: 'Conteúdo do arquivo está vazio.' });
      }

      const boundary = 'AdobeBoundary' + Date.now();
      const bodyStr  = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="File"; filename="${filename}"`,
        `Content-Type: ${mimeType}`,
        '',
        content,
        `--${boundary}--`,
      ].join('\r\n');

      const response = await fetch(`${BASE}/transientDocuments`, {
        method:  'POST',
        headers: { ...authHeaders, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body:    bodyStr,
      });

      const data = await response.json();
      if (!response.ok) {
        console.error('[adobe-sign] upload falhou:', data);
        return res.status(response.status).json(traduzirErro(data));
      }
      return res.status(200).json(data);
    }

    // ── action: createAgreement ─ envelope de assinatura ──────────────
    if (action === 'createAgreement') {
      const { transientDocumentId, name, signers, message } = params;

      if (!transientDocumentId || !name || !Array.isArray(signers) || !signers.length) {
        return res.status(400).json({
          error: 'Parâmetros obrigatórios: transientDocumentId, name, signers[].',
        });
      }

      // Valida e-mails dos signatários
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      for (const s of signers) {
        if (!emailRegex.test(s.email || '')) {
          return res.status(400).json({ error: `E-mail inválido: "${s.email}".` });
        }
      }

      const payload = {
        fileInfos: [{ transientDocumentId }],
        name,
        message: message || `Por favor, assine o documento: ${name}`,
        participantSetsInfo: signers.map((s, i) => ({
          memberInfos: [{ email: s.email, name: s.name || s.email }],
          order: typeof s.order === 'number' ? s.order : i + 1,
          role:  'SIGNER',
        })),
        signatureType: 'ESIGN',
        state:         'IN_PROCESS',
      };

      const response = await fetch(`${BASE}/agreements`, {
        method:  'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error('[adobe-sign] createAgreement falhou:', data);
        return res.status(response.status).json(traduzirErro(data));
      }
      return res.status(200).json(data);
    }

    // ── action: getSigningUrls ─ URLs de assinatura ──────────────────────
    if (action === 'getSigningUrls') {
      const { agreementId } = params;
      if (!agreementId) {
        return res.status(400).json({ error: 'Parâmetro obrigatório: agreementId.' });
      }

      const response = await fetch(
        `${BASE}/agreements/${encodeURIComponent(agreementId)}/signingUrls`,
        { headers: authHeaders }
      );
      const data = await response.json();
      return res.status(response.status).json(data);
    }

    return res.status(400).json({
      error: `Ação desconhecida: "${action}". Use: status, upload, createAgreement, getSigningUrls.`,
    });
  } catch (err) {
    console.error('[adobe-sign] erro interno:', err);
    return res.status(500).json({ error: err.message || 'Erro interno do servidor.' });
  }
};
