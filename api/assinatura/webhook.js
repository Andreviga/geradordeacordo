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
// Fase E: substituir Set em memória por tabela `eventos_webhook` no banco.

'use strict';

// Idempotência em memória (best-effort — reinicia a cada cold start).
// A Fase E substituirá por tabela no banco de dados.
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

  // Responder 200 imediatamente — ZapSign reenvia se demorar
  res.status(200).json({ ok: true });

  // Processar de forma assíncrona sem bloquear a resposta
  processarEvento(req.body).catch(err => console.error('[webhook] Erro no processamento:', err));
};

async function processarEvento(body) {
  const { event_type, document } = body || {};
  if (!event_type || !document?.token) {
    console.warn('[webhook] Payload inválido:', JSON.stringify(body).slice(0, 200));
    return;
  }

  // ── Idempotência ─────────────────────────────────────────────────────────
  const chave = `${event_type}:${document.token}`;
  if (eventosProcessados.has(chave)) {
    console.log(`[webhook] Evento duplicado ignorado: ${chave}`);
    return;
  }
  eventosProcessados.add(chave);
  if (eventosProcessados.size > MAX_EVENTOS) {
    // Limpar metade dos eventos (mantém os mais recentes)
    const antiga = [...eventosProcessados].slice(0, Math.floor(MAX_EVENTOS / 2));
    antiga.forEach(k => eventosProcessados.delete(k));
  }

  console.log(`[webhook] Evento: ${event_type} | Doc: ${document.token} | ExternalId: ${document.external_id || '—'}`);

  switch (event_type) {
    case 'doc_signed':
      // ⚠️ signed_file expira em 60 minutos — BAIXAR IMEDIATAMENTE
      // A Fase E implementará: download → salvar em storage → marcar no banco
      console.log(`[webhook] ASSINADO: ${document.token}`);
      console.log(`[webhook] signed_file (expira em 60min): ${document.signed_file || '(ainda nulo)'}`);
      console.log(`[webhook] external_id: ${document.external_id || '—'}`);
      // TODO Fase E: baixar signed_file e persistir no storage (Supabase Storage ou similar)
      // TODO Fase E: atualizar registro do acordo como 'assinado' no banco
      break;

    case 'doc_refused':
      console.log(`[webhook] RECUSADO: ${document.token}`);
      // TODO Fase E: atualizar status no banco e notificar secretaria
      break;

    case 'email_bounce':
      console.log(`[webhook] E-MAIL INVÁLIDO (bounce): ${document.token}`);
      // TODO Fase E: marcar e-mail como inválido e notificar secretaria para correção
      break;

    case 'doc_created':
      console.log(`[webhook] CRIADO: ${document.token}`);
      break;

    case 'doc_deleted':
      console.log(`[webhook] EXCLUÍDO: ${document.token}`);
      break;

    default:
      console.log(`[webhook] Evento não tratado: ${event_type}`);
  }
}

// Exportar para testes unitários
module.exports.processarEvento = processarEvento;
module.exports.eventosProcessados = eventosProcessados;
