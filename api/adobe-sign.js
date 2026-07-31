// api/adobe-sign.js — Vercel Serverless Function
// Proxy para Adobe Acrobat Sign REST API.
// Necessário porque o navegador não consegue chamar a API do Adobe Sign diretamente (bloqueio de CORS).

module.exports = async function handler(req, res) {
  // Cabeçalhos CORS para chamadas da mesma origem (e desenvolvimento local)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const { action, key, region = 'na4', ...params } = req.body || {};

  if (!key) {
    return res.status(400).json({ error: 'Parâmetro obrigatório ausente: key (Integration Key do Adobe Sign).' });
  }
  if (!action) {
    return res.status(400).json({ error: 'Parâmetro obrigatório ausente: action.' });
  }

  // Valida o nome da região para evitar SSRF
  const REGIOES_VALIDAS = ['na1', 'na2', 'na4', 'eu1', 'eu2', 'au1', 'jp1', 'in1'];
  if (!REGIOES_VALIDAS.includes(region)) {
    return res.status(400).json({ error: `Região inválida: ${region}. Use: ${REGIOES_VALIDAS.join(', ')}.` });
  }

  const BASE = `https://api.${region}.adobesign.com/api/rest/v6`;
  const authHeaders = { Authorization: `Bearer ${key}` };

  try {
    // ── Ação 1: Upload de documento transitório ────────────────────────────
    if (action === 'upload') {
      const { filename, content, mimeType = 'text/html' } = params;

      if (!filename || content === undefined) {
        return res.status(400).json({ error: 'Parâmetros obrigatórios para upload: filename, content.' });
      }

      const boundary = 'AdobeBoundary' + Date.now();
      const bodyStr = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="File"; filename="${filename}"`,
        `Content-Type: ${mimeType}`,
        '',
        content,
        `--${boundary}--`,
      ].join('\r\n');

      const response = await fetch(`${BASE}/transientDocuments`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: bodyStr,
      });

      const data = await response.json();
      return res.status(response.status).json(data);
    }

    // ── Ação 2: Criar acordo (envelope de assinatura) ──────────────────────
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
          return res.status(400).json({ error: `E-mail inválido: ${s.email}` });
        }
      }

      const payload = {
        fileInfos: [{ transientDocumentId }],
        name,
        message: message || `Por favor, assine o documento: ${name}`,
        participantSetsInfo: signers.map((s, i) => ({
          memberInfos: [{ email: s.email, name: s.name || s.email }],
          order: typeof s.order === 'number' ? s.order : i + 1,
          role: 'SIGNER',
        })),
        signatureType: 'ESIGN',
        state: 'IN_PROCESS',
      };

      const response = await fetch(`${BASE}/agreements`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      return res.status(response.status).json(data);
    }

    // ── Ação 3: Consultar URLs de assinatura ───────────────────────────────
    if (action === 'getSigningUrls') {
      const { agreementId } = params;
      if (!agreementId) {
        return res.status(400).json({ error: 'Parâmetro obrigatório: agreementId.' });
      }

      const response = await fetch(`${BASE}/agreements/${encodeURIComponent(agreementId)}/signingUrls`, {
        headers: authHeaders,
      });

      const data = await response.json();
      return res.status(response.status).json(data);
    }

    return res.status(400).json({ error: `Ação desconhecida: "${action}". Use: upload, createAgreement, getSigningUrls.` });
  } catch (err) {
    console.error('[adobe-sign] Erro interno:', err);
    return res.status(500).json({ error: err.message || 'Erro interno do servidor.' });
  }
};
