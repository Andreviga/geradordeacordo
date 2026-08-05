'use strict';
// api/vencidas.js  →  GET /api/vencidas?minDias=1&maxDias=999

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

  const minDias = parseInt(req.query?.minDias) || 1;
  const maxDias = parseInt(req.query?.maxDias) || 9999;

  try {
    const pool = getPool();
    if (!pool) return res.status(503).json({ erro: 'Banco indisponível' });

    const { rows } = await pool.query(
      `SELECT
         p.id,
         p.numero           AS parcela_numero,
         p.vencimento,
         (-pcs.dias_para_vencimento) AS dias_atraso,
         pcs.saldo_cts,
         p.tratamento_manual,
         p.valor_pago_cts,
         p.valor_previsto_cts,
         a.id               AS acordo_id,
         a.numero           AS acordo_numero,
         a.lembretes_ativos,
         STRING_AGG(DISTINCT d.nome,      ', ' ORDER BY d.nome)     AS devedores,
         STRING_AGG(DISTINCT d.telefone,  ', ')                      AS telefones,
         (SELECT MAX(le.criado_em)
          FROM lembretes_enviados le
          WHERE le.parcela_id = p.id AND le.status = 'ok')          AS ultimo_lembrete
       FROM parcelas_com_status pcs
       JOIN parcelas p ON p.id = pcs.id
       JOIN acordos  a ON a.id = p.acordo_id
       JOIN acordo_devedores ad ON ad.acordo_id = a.id
       JOIN devedores d ON d.id = ad.devedor_id
       WHERE pcs.status = 'vencido'
         AND NOT a.cancelado
         AND (-pcs.dias_para_vencimento) >= $1
         AND (-pcs.dias_para_vencimento) <= $2
       GROUP BY p.id, p.numero, p.vencimento, pcs.dias_para_vencimento, pcs.saldo_cts,
                p.tratamento_manual, p.valor_pago_cts, p.valor_previsto_cts,
                a.id, a.numero, a.lembretes_ativos
       ORDER BY p.vencimento ASC, a.numero
       LIMIT 200`,
      [minDias, maxDias]
    );

    return res.status(200).json({ vencidas: rows });
  } catch (err) {
    if (isDbUnavailable(err)) return res.status(503).json({ erro: 'Banco indisponível' });
    console.error('[vencidas]', err.message);
    return res.status(500).json({ erro: 'Erro interno' });
  }
};
