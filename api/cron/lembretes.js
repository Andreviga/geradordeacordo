'use strict';
// api/cron/lembretes.js — endpoint chamado pelo scheduler Vercel.
// CRON DESATIVADO: não há entrada em vercel.json. Ativar só após dry-run aprovado.
// Chamada manual: POST /api/cron/lembretes  Authorization: Bearer $CRON_SECRET

const { executarLembretes } = require('./_lembretes_engine');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  // O scheduler do Vercel dispara o cron com GET (e manda o CRON_SECRET no
  // header Authorization). Recusar GET fazia o cron responder 405 a cada
  // execução — confirmado em produção — e nenhum lembrete era enviado.
  // POST segue aceito para invocação manual.
  if (req.method !== 'GET' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.CRON_SECRET;
  const token  = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!secret || token !== secret)
    return res.status(401).json({ error: 'Unauthorized' });

  try {
    const result = await executarLembretes({ dryRun: false });
    console.log('[cron/lembretes] concluído:', result);
    return res.status(200).json(result);
  } catch (err) {
    console.error('[cron/lembretes] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
