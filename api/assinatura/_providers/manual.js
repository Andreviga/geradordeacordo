// api/assinatura/_providers/manual.js — provedor manual (gov.br)
//
// Não faz chamada de rede. Calcula SHA-256 do PDF e devolve instruções
// sequenciais para assinatura no portal gov.br.
//
// ⚠️  ATENÇÃO — ASSINATURA SEQUENCIAL:
//     Cada signatário deve assinar o arquivo já assinado pelo anterior,
//     nunca o arquivo original. Assinar arquivos distintos produz dois PDFs
//     com uma assinatura cada — sem validade como instrumento conjunto.

'use strict';

const crypto = require('crypto');

async function enviar({ buffer, nomeDocumento, signatarios }) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const nomes  = signatarios.map((s, i) => `${i + 1}. ${s.nome || s.email}`).join('; ');

  return {
    id:       `manual-${Date.now().toString(36).toUpperCase()}`,
    status:   'pendente',
    provedor: 'manual',
    url:      [],
    sha256,
    nomeDocumento,
    instrucoes: [
      `Documento: "${nomeDocumento}"`,
      `Signatários (em ordem): ${nomes}`,
      `SHA-256 do arquivo original: ${sha256}`,
      '─'.repeat(64),
      'Como assinar via gov.br — leia com atenção:',
      '1. Cada signatário deve ter conta gov.br com nível Prata ou Ouro.',
      '   Conta Bronze não habilita assinatura eletrônica avançada.',
      '2. Acesse assinador.iti.gov.br e faça login com gov.br.',
      `3. O signatário 1 (${signatarios[0]?.nome || 'primeiro'}) faz upload do PDF original e assina.`,
      '   Baixe o arquivo assinado gerado pelo portal (não o original).',
      '4. O signatário 2 (e seguintes) faz upload do arquivo JÁ ASSINADO pelo anterior,',
      '   nunca do PDF original. Repita até todos assinarem.',
      '5. O resultado final pode ser verificado em validar.iti.gov.br.',
      `6. Confirme o SHA-256 do arquivo original: ${sha256}`,
      '   O hash do arquivo final assinado será diferente — isso é esperado.',
    ],
  };
}

async function consultar() {
  return {
    error: 'Consulta de status em tempo real não está disponível no modo manual (gov.br).',
    code:  'NOT_SUPPORTED',
  };
}

module.exports = { enviar, consultar };
