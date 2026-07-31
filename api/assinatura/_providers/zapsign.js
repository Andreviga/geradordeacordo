// api/assinatura/_providers/zapsign.js — adapter ZapSign
//
// Documentação oficial: https://docs.zapsign.com.br/
//
// Riscos conhecidos documentados no código:
//   • original_file e signed_file expiram em 60 minutos — nunca guardar a URL
//   • Sem endpoint de consulta de cota — tratamento reativo (captura o erro)
//   • Cache de 60 min na listagem — usar endpoint de detalhe para status pontual
//   • Webhooks: registrar em /api/assinatura/webhook (ver arquivo de webhook)

'use strict';

const { normalizarStatus, erroNormalizado, gerarExternalId } = require('../_contrato');

const BASE_URL = 'https://api.zapsign.com.br/api/v1';

// ── Tradução de erros ─────────────────────────────────────────────────────
function traduzirErroZapSign(status, body) {
  const raw = (body?.detail || body?.message || body?.error || '').toString();
  const low = raw.toLowerCase();

  if (status === 401 || low.includes('invalid token') || low.includes('authentication')) {
    return erroNormalizado(
      'Token da API ZapSign inválido ou expirado. Verifique ZAPSIGN_API_TOKEN.',
      'INVALID_TOKEN'
    );
  }
  if (status === 402 || low.includes('limit') || low.includes('quota') || low.includes('plan') || low.includes('excedido')) {
    return { ...erroNormalizado('Cota mensal da ZapSign esgotada.', 'QUOTA_EXCEEDED'), fallback: true };
  }
  if (low.includes('credit') || low.includes('crédito') || low.includes('insufficient credit')) {
    return erroNormalizado(
      'Créditos ZapSign insuficientes para o envio por WhatsApp. O documento será reenviado apenas por e-mail.',
      'INSUFFICIENT_CREDITS'
    );
  }
  if (status === 413 || low.includes('too large') || low.includes('size')) {
    return erroNormalizado(
      'PDF muito grande para a ZapSign (limite: 10 MB). Reduza a marca d\'água ou desative o timbre e tente novamente.',
      'PDF_TOO_LARGE'
    );
  }
  if (status === 400 && (low.includes('email') || low.includes('e-mail'))) {
    return erroNormalizado('E-mail de signatário inválido ou rejeitado pela ZapSign.', 'INVALID_EMAIL');
  }
  // Fallback com código bruto para diagnóstico em produção
  const code = body?.code || String(status);
  return erroNormalizado(`Erro ZapSign [${code}]: ${raw || 'sem detalhes'}`, code);
}

// ── Construção do payload ─────────────────────────────────────────────────
function construirPayload({ pdfBase64, nomeDocumento, signatarios, mensagem, externalId, enviarWhatsapp, credoraNome, dataLimite }) {
  const QUALIFICACOES = { devedor: 'devedor', credora: 'credora', testemunha: 'testemunha' };

  const signersList = signatarios.map((s, i) => {
    const papel  = QUALIFICACOES[s.papel] || 'devedor';
    const signer = {
      name:                    s.nome || s.email,
      email:                   s.email,
      auth_mode:               'assinaturaTela-tokenEmail', // gratuito; SMS/WhatsApp/ICP são pagos
      lock_name:               true,
      lock_email:              true,
      require_cpf:             !!(s.cpf),
      validate_cpf:            !!(s.cpf), // gratuito; valida CPF+nome+nascimento na Receita Federal
      send_automatic_email:    true,
      send_automatic_whatsapp: false,     // default off — custo R$ 0,50 por envio
      qualification:           papel,
      custom_message:          mensagem || '',
      // Âncora de posicionamento — deve coincidir com o texto invisível no PDF
      signature_placement:     `<<${papel}${i + 1}>>`,
      // Fase E: external_id do signatário (CPF ou ID gerado)
      external_id: s.externalId || (s.cpf ? s.cpf.replace(/\D/g, '') : gerarExternalId(`signer-${i + 1}`)),
    };

    if (s.cpf) signer.cpf = s.cpf.replace(/\D/g, '');

    // WhatsApp opcional — exige phone_country + phone_number
    if (enviarWhatsapp && s.telefone) {
      const tel = s.telefone.replace(/\D/g, '');
      if (tel.length >= 10) {
        signer.send_automatic_whatsapp = true;
        signer.phone_country           = '55';
        signer.phone_number            = tel;
      }
    }

    return signer;
  });

  return {
    name:                   nomeDocumento,
    base64_pdf:             pdfBase64,
    lang:                   'pt-br',
    external_id:            externalId,
    folder_path:            '/acordos/',
    date_limit_to_sign:     dataLimite,
    signature_order_active: false,    // todos assinam em paralelo
    allow_refuse_signature: true,     // recusa é informação, não silêncio
    reminder_every_n_days:  3,        // lembretes gratuitos de assinatura pendente
    brand_name:             credoraNome || 'Colégio Raízes', // "X via ZapSign" no e-mail
    signers:                signersList,
  };
}

// ── Normalização da resposta ──────────────────────────────────────────────
function normalizarResposta(data) {
  const signers = (data.signers || []).map((s, i) => ({
    nome:      s.name,
    email:     s.email,
    url:       s.sign_url || `https://app.zapsign.com.br/verificar/${s.token}`,
    status:    normalizarStatus(s.status, 'zapsign'),
    token:     s.token,
    signadoEm: s.signed_at || null,
  }));

  return {
    id:       data.token,
    status:   normalizarStatus(data.status, 'zapsign'),
    provedor: 'zapsign',
    url:      signers,
    // ⚠️ NÃO persistir original_file nem signed_file — expiram em 60 min.
    // A Fase E usará o webhook doc_signed para baixar e persistir o arquivo assinado.
  };
}

// ── Idempotência via external_id ──────────────────────────────────────────
async function consultarPorExternalId(externalId, apiToken) {
  try {
    const r = await fetch(`${BASE_URL}/docs/?external_id=${encodeURIComponent(externalId)}`, {
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) return normalizarResposta(data[0]);
    if (data?.token) return normalizarResposta(data);
    return null;
  } catch {
    return null; // falha silenciosa — melhor tentar criar do que bloquear
  }
}

// ── Enviar documento ──────────────────────────────────────────────────────
async function enviar({ pdfBase64, buffer, nomeDocumento, signatarios, mensagem, externalId, enviarWhatsapp, credoraNome }) {
  const apiToken = process.env.ZAPSIGN_API_TOKEN;
  if (!apiToken) return erroNormalizado('ZAPSIGN_API_TOKEN não configurado no servidor.', 'NOT_CONFIGURED');

  // Idempotência: verificar se documento com este external_id já existe (retry seguro)
  const existente = await consultarPorExternalId(externalId, apiToken);
  if (existente && existente.id) return existente;

  const dataLimite = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const payload = construirPayload({ pdfBase64, nomeDocumento, signatarios, mensagem, externalId, enviarWhatsapp, credoraNome, dataLimite });

  let response, data;
  try {
    response = await fetch(`${BASE_URL}/docs/`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    data = await response.json();
  } catch (err) {
    return erroNormalizado(
      `Erro de rede ao conectar com a ZapSign: ${err.message}. Verifique a conexão e tente novamente.`,
      'NETWORK_ERROR'
    );
  }

  if (!response.ok) {
    const erro = traduzirErroZapSign(response.status, data);
    // Créditos insuficientes para WhatsApp: retentar sem WhatsApp
    if (erro.code === 'INSUFFICIENT_CREDITS' && enviarWhatsapp) {
      const semWA = construirPayload({ pdfBase64, nomeDocumento, signatarios, mensagem, externalId, enviarWhatsapp: false, credoraNome, dataLimite });
      try {
        const r2   = await fetch(`${BASE_URL}/docs/`, { method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(semWA) });
        const d2   = await r2.json();
        if (r2.ok) {
          const resp = normalizarResposta(d2);
          resp.aviso = 'Créditos insuficientes para WhatsApp — enviado apenas por e-mail.';
          return resp;
        }
      } catch { /* ignora */ }
    }
    return erro;
  }

  return normalizarResposta(data);
}

// ── Consultar status ──────────────────────────────────────────────────────
// ⚠️ Usar apenas para consulta pontual — a listagem tem cache de 60 min.
// Para monitoramento em tempo real, configure webhooks (/api/assinatura/webhook).
async function consultar(documentoId) {
  const apiToken = process.env.ZAPSIGN_API_TOKEN;
  if (!apiToken) return erroNormalizado('ZAPSIGN_API_TOKEN não configurado.', 'NOT_CONFIGURED');
  try {
    const r    = await fetch(`${BASE_URL}/docs/${encodeURIComponent(documentoId)}/`, { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } });
    const data = await r.json();
    if (!r.ok) return traduzirErroZapSign(r.status, data);
    return normalizarResposta(data);
  } catch (err) {
    return erroNormalizado('Erro ao consultar documento na ZapSign: ' + err.message, 'NETWORK_ERROR');
  }
}

module.exports = {
  enviar, consultar,
  // Exportados para os testes unitários
  construirPayload, normalizarResposta, traduzirErroZapSign, consultarPorExternalId,
};
