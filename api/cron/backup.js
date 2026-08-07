'use strict';
// api/cron/backup.js — cron semanal: dump JSON do banco → Google Drive.
// Schedule: toda segunda-feira às 06h UTC (vercel.json: "0 6 * * 1")
// Autenticação: Authorization: Bearer $CRON_SECRET (igual ao cron de lembretes)
//
// Lógica de retenção:
//   - Backup semanal : 4 semanas (deleta o 5º mais antigo)
//   - Backup mensal  : 12 meses  (deleta o 13º mais antigo)
//     → criado toda primeira segunda-feira do mês

const { getPool }          = require('../_db');
const { executarBackup }   = require('./_backup_engine');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.CRON_SECRET;
  const token  = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!secret || token !== secret)
    return res.status(401).json({ error: 'Unauthorized' });

  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL não configurado' });

  try {
    const result = await executarBackup(pool);
    console.log('[cron/backup] concluído:', result);
    return res.status(200).json(result);
  } catch (err) {
    console.error('[cron/backup] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
