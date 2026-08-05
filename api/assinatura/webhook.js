// api/assinatura/webhook.js — receptor de webhooks da ZapSign
//
// Endpoint: POST /api/assinatura/webhook
//
// Configure no painel ZapSign: Configurações → Integrações → API → Webhooks
// URL: https://SEU_DOMINIO.vercel.app/api/assinatura/webhook
//
// Eventos:
//   doc_created  doc_signed  doc_refused  doc_deleted  email_bounce
//
// ⚠️  "Todos os eventos" NÃO inclui email_bounce — assinar separadamente.
//
// Variável de ambiente obrigatória:
//   ZAPSIGN_WEBHOOK_SECRET — segredo configurado no painel da ZapSign
//                            (Configurações → Webhooks → Header customizado)
//
//   ZAPSIGN_WEBHOOK_SECRET       segredo configurado no painel da ZapSign
//   GOOGLE_SERVICE_ACCOUNT_JSON  credenciais da conta de serviço GCP (obrigatório para doc_signed)
//   DRIVE_PDF_FOLDER_ID          ID da pasta do Drive Compartilhado para PDFs assinados
//
// Comportamento:
//   doc_signed    — processado SINCRONAMENTE; responde 500 em caso de falha p/ ZapSign reenviar.
//                   Se GOOGLE_SERVICE_ACCOUNT_JSON não estiver configurado, responde 500 sempre
//                   (fail-loud, não fallback silencioso).
//   outros eventos — responde 200 imediatamente; log assíncrono. (opcional)

'use strict';

const { verificarEvento, marcarEvento, marcarFalha, salvarPdfAssinado } = require('./_drive');
const { buscarSignedFile } = require('./_providers/zapsign');

// ZapSign efetua até 3 retentativas com backoff exponencial (doc: https://docs.zapsign.com.br).
// Após MAX_RETRIES falhas registradas, o webhook responde 200 para parar o loop e loga
// erro permanente visível nos logs do Vercel e no painel de webhooks da ZapSign.
const MAX_RETRIES = 3;

// Set in-memory somente para eventos não-críticos (doc_refused, email_bounce, doc_created).
const eventosProcessados = new Set();
const MAX_EVENTOS        = 1000;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).end();

  // ── Validar segredo do webhook ───────────────────────────────────────────
  const secreto = process.env.ZAPSIGN_WEBHOOK_SECRET;
  if (secreto) {
    // A ZapSign envia o segredo em header customizado configurado no painel
    const recebido = req.headers['x-webhook-secret']
                  || req.headers['x-zapsign-secret']
                  || req.headers['authorization']
                  || '';
    if (recebido !== secreto) {
      console.warn('[webhook] Segredo inválido — request rejeitado.');
      return res.status(401).json({ error: 'Webhook secret inválido.' });
    }
  }

  // doc_signed: síncrono — responde 500 em falha para ZapSign reenviar
  if ((req.body || {}).event_type === 'doc_signed') {
    try {
      await processarDocSigned(req.body);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[webhook] FALHA em doc_signed (ZapSign vai reenviar):', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // Outros eventos: processar sincronamente antes de responder
  // (Vercel encerra a função após res.end() — código depois não roda)
  try { await processarEventoNaoCritico(req.body); } catch (err) {
    console.error('[webhook] Erro em evento não-crítico:', err.message);
  }
  return res.status(200).json({ ok: true });
};

async function processarDocSigned(body) {
  const { document } = body || {};
  if (!document?.token) throw new Error('Payload inválido: document.token ausente');

  const chave = `doc_signed:${document.token}`;

  const estado = await verificarEvento(chave); // null = SA não configurado
  if (estado === null) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON não configurado. ' +
      'Configure a conta de serviço para persistir o PDF assinado.'
    );
  }
  if (estado.status === 'ok') {
    console.log(`[webhook] doc_signed duplicado ignorado: ${chave}`);
    return;
  }

  // Após MAX_RETRIES falhas persistidas, responde 200 para parar o loop da ZapSign
  const failCount = estado.failCount || 0;
  if (failCount >= MAX_RETRIES) {
    console.error(
      `[webhook] 🔴 FALHA PERMANENTE ${chave} (último erro: ${estado.ultimoErro || '?'}). ` +
      `Intervenção manual necessária — verifique logs do Vercel e painel de webhooks ZapSign.`
    );
    return; // 200 para encerrar retentativas
  }

  // Buscar URL FRESCA da ZapSign — não usar a URL do payload (expira em 60 min)
  let signedUrl;
  try {
    signedUrl = await buscarSignedFile(document.token);
  } catch (err) {
    await marcarFalha(chave, err.message, document.token);
    throw err;
  }

  if (!signedUrl) {
    const msg = 'signed_file indisponível na API ZapSign (documento ainda em processamento)';
    await marcarFalha(chave, msg, document.token);
    throw new Error(msg);
  }

  // Baixar e salvar ANTES de marcar como processado
  try {
    const nome = `Assinado-${document.external_id || document.token}.pdf`;
    const driveId = await salvarPdfAssinado(signedUrl, nome);
    console.log(`[webhook] PDF assinado salvo no Drive: ${driveId}`);
    // TODO Fase E: gravar driveId no banco
  } catch (err) {
    await marcarFalha(chave, err.message, document.token);
    throw err;
  }

  await marcarEvento(chave);
  console.log(`[webhook] ASSINADO e registrado: ${document.token}`);
}

async function processarEventoNaoCritico(body) {
  const { event_type, document } = body || {};
  if (!event_type || !document?.token) {
    console.warn('[webhook] Payload inválido:', JSON.stringify(body).slice(0, 200));
    return;
  }

  // Idempotência in-memory (best-effort) para eventos não-críticos
  const chave = `${event_type}:${document.token}`;
  if (eventosProcessados.has(chave)) return;
  eventosProcessados.add(chave);
  if (eventosProcessados.size > MAX_EVENTOS) {
    [...eventosProcessados].slice(0, Math.floor(MAX_EVENTOS / 2)).forEach(k => eventosProcessados.delete(k));
  }

  console.log(`[webhook] ${event_type}: ${document.token} | ExternalId: ${document.external_id || '—'}`);

  switch (event_type) {
    case 'doc_refused':
      // TODO Fase E: atualizar status no banco e notificar secretaria
      break;
    case 'email_bounce':
      // TODO Fase E: marcar e-mail como inválido
      break;
    case 'doc_created':
    case 'doc_deleted':
      break;
    default:
      console.log(`[webhook] Evento não tratado: ${event_type}`);
  }
}

// Exportar para testes unitários
module.exports.processarDocSigned       = processarDocSigned;
module.exports.processarEventoNaoCritico = processarEventoNaoCritico;
module.exports.eventosProcessados        = eventosProcessados;
