// api/assinatura/_contrato.js — validações comuns da preparação para assinatura
//
// Função         Responsabilidade
// erroNormalizado     Formato de erro único (mensagem PT-BR + código bruto)
// gerarExternalId     ID do documento, para conferência posterior
// validarSignatarios  Valida lista antes de preparar o documento
// validarPDF          Valida e decodifica PDF base64, verifica limite de 10 MB
//
// O STATUS_MAP que traduzia status de ZapSign e Adobe saiu junto com esses
// provedores: o gov.br não devolve status, quem confere é a secretaria no portal.

'use strict';

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
      error: `PDF muito grande (${mb} MB). Limite: 10 MB. ` +
             'Reduza a intensidade da marca d\'água ou desative o timbre com imagem e tente novamente.',
      buffer: null, base64: null,
    };
  }

  return { error: null, buffer, base64: b64 };
}

module.exports = { erroNormalizado, gerarExternalId, validarSignatarios, validarPDF };
