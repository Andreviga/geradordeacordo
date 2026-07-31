// api/assinatura/_providers/adobe.js — adapter Adobe Acrobat Sign
// Preservado da implementação anterior (api/adobe-sign.js).
// Requer conta Enterprise; não é o provedor padrão.

'use strict';

const { erroNormalizado, normalizarStatus } = require('../_contrato');

const MSGS_ADOBE = {
  INVALID_ACCESS_TOKEN:     'Integration Key inválida ou expirada (ADOBE_SIGN_INTEGRATION_KEY).',
  INVALID_USER:             'Usuário não encontrado na conta Adobe Sign.',
  USER_NOT_ACTIVE:          'Conta Adobe Sign inativa.',
  AGREEMENT_NOT_MODIFIABLE: 'O acordo não pode ser modificado no estado atual.',
  INVALID_PARTICIPANT:      'E-mail de signatário inválido ou não aceito pelo Adobe Sign.',
  DUPLICATE_PARTICIPANT:    'E-mail duplicado na lista de signatários.',
  MISSING_REQUIRED_PARAM:   'Parâmetro obrigatório ausente na requisição.',
  NO_FILE_CONTENT:          'Arquivo enviado está vazio.',
  REQUEST_LIMIT_EXCEEDED:   'Limite de requisições da API Adobe Sign atingido. Aguarde e tente novamente.',
  PLAN_LIMIT_EXCEEDED:      'Cota mensal do plano Adobe Sign esgotada.',
};

function traduzirErroAdobe(status, data) {
  const code = data?.code || '';
  const msg  = MSGS_ADOBE[code] || (code ? `[${code}] ${(data?.message || '').trim()}` : data?.message || 'Erro desconhecido Adobe Sign.');
  const fallback = status === 402 || code === 'PLAN_LIMIT_EXCEEDED' || code === 'REQUEST_LIMIT_EXCEEDED';
  return { ...erroNormalizado(msg, code), fallback };
}

async function enviar({ pdfBase64, nomeDocumento, signatarios, mensagem }) {
  const KEY    = process.env.ADOBE_SIGN_INTEGRATION_KEY;
  const REGION = (process.env.ADOBE_SIGN_REGION || 'na4').toLowerCase();
  if (!KEY) return { ...erroNormalizado('ADOBE_SIGN_INTEGRATION_KEY não configurado.', 'NOT_CONFIGURED'), fallback: true };

  const BASE = `https://api.${REGION}.adobesign.com/api/rest/v6`;
  const auth = { Authorization: `Bearer ${KEY}` };

  // 1. Upload do PDF como transient document
  const boundary = 'AdobeBoundary' + Date.now();
  const body1 = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="File"; filename="${nomeDocumento}.pdf"`,
    `Content-Type: application/pdf`,
    `Content-Transfer-Encoding: base64`,
    '',
    pdfBase64,
    `--${boundary}--`,
  ].join('\r\n');

  let upR, upD;
  try {
    upR = await fetch(`${BASE}/transientDocuments`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body:   body1,
    });
    upD = await upR.json();
  } catch (err) {
    return erroNormalizado('Erro de rede com Adobe Sign: ' + err.message, 'NETWORK_ERROR');
  }
  if (!upR.ok) return traduzirErroAdobe(upR.status, upD);

  // 2. Criar acordo
  const agPayload = {
    fileInfos:             [{ transientDocumentId: upD.transientDocumentId }],
    name:                  nomeDocumento,
    message:               mensagem,
    participantSetsInfo:   signatarios.map((s, i) => ({
      memberInfos: [{ email: s.email, name: s.nome }],
      order:       i + 1,
      role:        'SIGNER',
    })),
    signatureType: 'ESIGN',
    state:         'IN_PROCESS',
  };

  let agR, agD;
  try {
    agR = await fetch(`${BASE}/agreements`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(agPayload) });
    agD = await agR.json();
  } catch (err) {
    return erroNormalizado('Erro de rede com Adobe Sign: ' + err.message, 'NETWORK_ERROR');
  }
  if (!agR.ok) return traduzirErroAdobe(agR.status, agD);

  // 3. Obter URLs de assinatura
  let urlR, urlD;
  try {
    urlR = await fetch(`${BASE}/agreements/${agD.id}/signingUrls`, { headers: auth });
    urlD = await urlR.json();
  } catch (err) {
    return erroNormalizado('Erro ao obter URLs de assinatura Adobe: ' + err.message, 'NETWORK_ERROR');
  }

  const urls = (urlD.signingUrlSetInfos || [])
    .flatMap(s => s.signingUrls || [])
    .map((u, i) => ({
      nome:   signatarios[i]?.nome || u.email,
      email:  u.email,
      url:    u.esignUrl,
      status: 'pendente',
    }));

  return { id: agD.id, status: 'pendente', provedor: 'adobe', url: urls };
}

async function consultar(documentoId) {
  const KEY    = process.env.ADOBE_SIGN_INTEGRATION_KEY;
  const REGION = (process.env.ADOBE_SIGN_REGION || 'na4').toLowerCase();
  if (!KEY) return erroNormalizado('ADOBE_SIGN_INTEGRATION_KEY não configurado.', 'NOT_CONFIGURED');

  try {
    const r = await fetch(`https://api.${REGION}.adobesign.com/api/rest/v6/agreements/${documentoId}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const d = await r.json();
    if (!r.ok) return traduzirErroAdobe(r.status, d);
    return { id: d.id, status: normalizarStatus(d.status, 'adobe'), provedor: 'adobe', url: [] };
  } catch (err) {
    return erroNormalizado('Erro ao consultar Adobe Sign: ' + err.message, 'NETWORK_ERROR');
  }
}

module.exports = { enviar, consultar };
