// api/assinatura/_contrato.js — contrato interno único para todos os provedores
//
// Função         Responsabilidade
// normalizarStatus    Converte status do provedor para o nosso vocabulário
// erroNormalizado     Formato de erro único (mensagem PT-BR + código bruto)
// gerarExternalId     ID temporário até a Fase E ter banco de dados
// validarSignatarios  Valida lista antes de qualquer chamada de API
// validarPDF          Valida e decodifica PDF base64, verifica limite de 10 MB

'use strict';

const STATUS_MAP = {
  zapsign: { pending: 'pendente', signed: 'assinado', refused: 'recusado', canceled: 'cancelado' },
  adobe:   { OUT_FOR_SIGNATURE: 'pendente', SIGNED: 'assinado', DECLINED: 'recusado', CANCELLED: 'cancelado' },
  manual:  { aguardando: 'pendente' },
};

function normalizarStatus(statusProvedor, provedor) {
  return (STATUS_MAP[provedor] || {})[statusProvedor] || statusProvedor;
}

function erroNormalizado(msg, codigo, fallback = false) {
  return { error: msg, code: codigo || null, fallback };
}

function gerarExternalId(prefixo = 'doc') {
  return `${prefixo}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
}

/**
 * Valida a lista de signatários antes de qualquer chamada de API.
 * @returns {string|null} mensagem de erro em PT-BR, ou null se válido
 */
function validarSignatarios(signatarios) {
  if (!Array.isArray(signatarios) || signatarios.length === 0) {
    return 'Informe ao menos um signatário.';
  }
  const emailRE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const emails  = new Set();
  for (let i = 0; i < signatarios.length; i++) {
    const s     = signatarios[i];
    const label = `Signatário ${i + 1} (${s.nome || 'sem nome'})`;
    if (!s.email || !s.email.trim()) return `${label}: e-mail obrigatório.`;
    if (!emailRE.test(s.email.trim())) return `${label}: e-mail com formato inválido — "${s.email}".`;
    const norm = s.email.trim().toLowerCase();
    if (emails.has(norm)) return `E-mail duplicado: "${s.email}" — dois signatários com o mesmo e-mail não são permitidos.`;
    emails.add(norm);
  }
  return null;
}

/**
 * Valida e decodifica PDF em base64.
 * Aceita com ou sem prefixo "data:application/pdf;base64,".
 * @returns {{ error, buffer, base64 }}
 */
function validarPDF(base64) {
  if (!base64) return { error: 'PDF não fornecido.', buffer: null, base64: null };

  const b64 = String(base64).replace(/^data:[^;]+;base64,/, '');

  let buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch {
    return { error: 'PDF com encoding base64 inválido.', buffer: null, base64: null };
  }

  // Verificar assinatura mágica do PDF (%PDF-)
  if (buffer.length < 5 || buffer.slice(0, 5).toString('ascii') !== '%PDF-') {
    return { error: 'Arquivo recebido não é um PDF válido (assinatura %PDF- ausente).', buffer: null, base64: null };
  }

  const MB_10 = 10 * 1024 * 1024;
  if (buffer.length > MB_10) {
    const mb = (buffer.length / 1024 / 1024).toFixed(1);
    return {
      error: `PDF muito grande (${mb} MB). Limite da ZapSign: 10 MB. ` +
             'Reduza a intensidade da marca d\'água ou desative o timbre com imagem e tente novamente.',
      buffer: null, base64: null,
    };
  }

  return { error: null, buffer, base64: b64 };
}

module.exports = { normalizarStatus, erroNormalizado, gerarExternalId, validarSignatarios, validarPDF };
