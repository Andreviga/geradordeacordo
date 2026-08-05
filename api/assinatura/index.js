// api/assinatura/index.js — roteador principal de assinatura digital
//
// Endpoint: POST /api/assinatura
//
// Actions:
//   status    — retorna provedor ativo e recursos; isento de JWT e CORS (para verificação na carga)
//   pendencias — lista falhas permanentes no webhook; requer JWT
//   enviar    — envia documento para assinatura; requer JWT
//   consultar — consulta status de documento; requer JWT
//
// Fallback automático: se o provedor retornar { fallback: true } (ex: cota esgotada),
// reprocessa com o provedor 'manual' e inclui aviso na resposta.

'use strict';

const { verificarRequisicao, verificarRequisicaoComBanco, applyCors } = require('../_auth');
const { validarSignatarios, validarPDF, erroNormalizado, gerarExternalId } = require('./_contrato');
const _drive = require('./_drive'); // acesso via objeto (não desestruturado) para permitir mock nos testes

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
  const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.length) return true;
  const o = req.headers['origin'] || '';
  const r = req.headers['referer'] || '';
  // Sem header Origin/Referer = cliente não-browser (API, mobile, testes) = não é CSRF = permitir.
  // Origin só existe em requisições cross-origin de browsers; JWT já garante a autenticação.
  if (!o && !r) return true;
  return allowed.some(a => o.startsWith(a) || r.startsWith(a));
}

// Carrega o adapter do provedor configurado; cai em 'manual' se ausente/inválido
function getProvider() {
  const name = (process.env.ASSINATURA_PROVIDER || 'manual').toLowerCase().trim();
  try {
    return { name, provider: require(`./_providers/${name}.js`) };
  } catch {
    console.warn(`[assinatura] Provedor "${name}" não encontrado — usando manual.`);
    return { name: 'manual', provider: require('./_providers/manual.js') };
  }
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
    const { name } = getProvider();
    return res.status(200).json({
      configured: true, // manual está sempre disponível
      provedor:   name,
      features: {
        whatsapp:      name === 'zapsign',
        cpfValidation: name === 'zapsign',
        signUrls:      name !== 'manual',
      },
    });
  }
  // ── action: pendencias — lista falhas permanentes para a secretaria (requer JWT + banco) ──
  if (action === 'pendencias') {
    const usuario = await verificarRequisicaoComBanco(req, res);
    if (!usuario) return;
    if (!checkOrigin(req)) return res.status(403).json({ error: 'Origem não autorizada.' });
    const dados = await _drive.lerPendencias();
    return res.status(200).json(dados || {});
  }
  // ── JWT + banco para ações autenticadas, depois verificação de origem ──────
  const usuario = await verificarRequisicaoComBanco(req, res);
  if (!usuario) return;
  if (!checkOrigin(req)) return res.status(403).json({ error: 'Origem não autorizada.' });
  if (!usuario) return;

  const { name, provider } = getProvider();

  // ── action: enviar ───────────────────────────────────────────────────────
  if (action === 'enviar') {
    const { pdfBase64, signatarios, nomeDocumento, mensagem, externalId, enviarWhatsapp, credoraNome } = params;

    // Validações antes da chamada de API
    const erroSig = validarSignatarios(signatarios);
    if (erroSig) return res.status(400).json({ error: erroSig });

    const { error: erroPDF, buffer, base64 } = validarPDF(pdfBase64);
    if (erroPDF) return res.status(400).json({ error: erroPDF });

    const extId = externalId || gerarExternalId('acordo');

    let resultado = await provider.enviar({
      pdfBase64:     base64,
      buffer,
      nomeDocumento: nomeDocumento || 'Termo de Confissão de Dívida',
      signatarios,
      mensagem:      mensagem || '',
      externalId:    extId,
      enviarWhatsapp: !!enviarWhatsapp,
      credoraNome,
    });

    // Fallback automático para manual quando a cota esgotar
    if (resultado.fallback && name !== 'manual') {
      const manual = require('./_providers/manual.js');
      const rm = await manual.enviar({ buffer, nomeDocumento: nomeDocumento || 'Termo de Confissão de Dívida', signatarios });
      rm.aviso = `${resultado.error} — usando assinatura manual (gov.br) automaticamente.`;
      return res.status(200).json(rm);
    }

    if (resultado.error && !resultado.id) {
      return res.status(422).json(resultado);
    }

    return res.status(200).json(resultado);
  }

  // ── action: consultar ────────────────────────────────────────────────────
  if (action === 'consultar') {
    const { documentoId } = params;
    if (!documentoId) return res.status(400).json({ error: 'Parâmetro "documentoId" obrigatório.' });
    const resultado = await provider.consultar(documentoId);
    return res.status(resultado.error ? 422 : 200).json(resultado);
  }

  return res.status(400).json({
    error: `Ação desconhecida: "${action}". Use: status | enviar | consultar.`,
  });
};
