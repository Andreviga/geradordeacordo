'use strict';
// api/dashboard.js  →  GET /api/dashboard

const { verificarRequisicaoComBanco, applyCors } = require('./_auth');
const { getPool, isDbUnavailable }               = require('./_db');

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ erro: 'Método não permitido' });

  const user = await verificarRequisicaoComBanco(req, res);
  if (!user) return;

  try {
    const pool = getPool();
    if (!pool) return res.status(503).json({ erro: 'Banco indisponível' });

    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM acordos_com_status
         WHERE status IN ('ativo','inadimplente'))::int                AS ativos,
        (SELECT COUNT(*) FROM parcelas_com_status WHERE status = 'vencido')::int AS vencidas,
        (SELECT COUNT(*) FROM parcelas_com_status
         WHERE status = 'a_vencer' AND dias_para_vencimento <= 7)::int AS a_vencer_7,
        (SELECT COUNT(*) FROM parcelas
         WHERE valor_pago_cts IS NOT NULL
           AND valor_pago_cts > 0
           AND valor_pago_cts < valor_previsto_cts
           AND NOT renegociada)::int                                   AS parciais
    `);

    return res.status(200).json(rows[0] || {});
  } catch (err) {
    if (isDbUnavailable(err)) return res.status(503).json({ erro: 'Banco indisponível' });
    console.error('[dashboard]', err.message);
    return res.status(500).json({ erro: 'Erro interno' });
  }
};
