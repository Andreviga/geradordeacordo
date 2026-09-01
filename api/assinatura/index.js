// api/assinatura/index.js — preparação do documento para assinatura no gov.br
//
// Endpoint: POST /api/assinatura
//
// Actions:
//   status    — informa que a assinatura é via gov.br; isento de JWT (verificação na carga)
//   enviar    — calcula o SHA-256 e devolve as instruções de assinatura; requer JWT
//   consultar — não se aplica ao gov.br; responde NOT_SUPPORTED
//
// O gov.br não tem API de envio: quem assina é a pessoa, no portal, com a conta
// dela. Este endpoint não faz chamada de rede — ele valida o PDF e os
// signatários, calcula o hash de conferência e monta o passo a passo.
//
// Histórico: houve integração com ZapSign e Adobe Sign, com webhook e
// persistência do PDF assinado no Drive. Foram removidas — a assinatura passou a
// ser exclusivamente pelo gov.br. Nunca chegaram a gravar nada no banco, então a
// remoção não deixou dado órfão. O que sobrou está em api/assinatura/_providers/manual.js.

'use strict';

const { verificarRequisicaoComBanco, applyCors } = require('../_auth');
const { validarSignatarios, validarPDF, gerarExternalId } = require('./_contrato');
const govbr = require('./_providers/manual.js');

// Rate limiting compartilhado
const rateLimits = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  let e = rateLimits.get(ip);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + 60_000 };
  e.count++;
  rateLimits.set(ip, e);
  return e.count <= 20;
}

function checkOrigin(req) {
  const semBarra = s => s.replace(/\/+$/, '');
  const allowed  = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => semBarra(s.trim())).filter(Boolean);
  if (!allowed.length) return true;
  const o = req.headers['origin']  || '';
  const r = req.headers['referer'] || '';
  // Sem header Origin/Referer = cliente não-browser (API, mobile, testes) = não é CSRF = permitir.
  // Origin só existe em requisições cross-origin de browsers; JWT já garante a autenticação.
  if (!o && !r) return true;
  // Comparação exata na origem; no referer, a barra separa o host do caminho, de
  // modo que "https://site.app/" não casa com "https://site.app.atacante.com".
  return allowed.some(a => semBarra(o) === a || r.startsWith(a + '/'));
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Método não permitido.' });

  const ip = ((req.headers['x-forwarded-for'] || '') || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Muitas requisições. Aguarde um minuto.' });

  const { action, ...params } = req.body || {};
  if (!action) return res.status(400).json({ error: 'Parâmetro "action" obrigatório.' });

  // ── action: status — isento de JWT ──────────────────────────────────────
  if (action === 'status') {
    return res.status(200).json({
      configured: true,        // gov.br não depende de configuração no servidor
      provedor:   'manual',    // nome mantido: é o que o frontend já entende
      portal:     'gov.br',
      features: { whatsapp: false, cpfValidation: false, signUrls: false },
    });
  }

  // ── JWT + banco para as ações autenticadas, depois verificação de origem ──
  const usuario = await verificarRequisicaoComBanco(req, res);
  if (!usuario) return;
  if (!checkOrigin(req)) return res.status(403).json({ error: 'Origem não autorizada.' });

  // ── action: enviar ───────────────────────────────────────────────────────
  if (action === 'enviar') {
    const { pdfBase64, signatarios, nomeDocumento, externalId } = params;

    const erroSig = validarSignatarios(signatarios);
    if (erroSig) return res.status(400).json({ error: erroSig });

    const { error: erroPDF, buffer, base64 } = validarPDF(pdfBase64);
    if (erroPDF) return res.status(400).json({ error: erroPDF });

    const resultado = await govbr.enviar({
      pdfBase64:     base64,
      buffer,
      nomeDocumento: nomeDocumento || 'Termo de Confissão de Dívida',
      signatarios,
      externalId:    externalId || gerarExternalId('acordo'),
    });

    if (resultado.error && !resultado.id) return res.status(422).json(resultado);
    return res.status(200).json(resultado);
  }

  // ── action: consultar ────────────────────────────────────────────────────
  if (action === 'consultar') {
    // O gov.br não expõe consulta de status: quem confere é a secretaria, no
    // portal de validação. Responde 422 com a explicação, sem fingir suporte.
    return res.status(422).json(await govbr.consultar());
  }

  return res.status(400).json({
    error: `Ação desconhecida: "${action}". Use: status | enviar | consultar.`,
  });
};
