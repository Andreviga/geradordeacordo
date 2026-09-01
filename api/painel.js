'use strict';
// api/painel.js — as duas telas de leitura da secretaria numa função só.
//
//   GET /api/painel?tipo=dashboard                     → contadores do painel
//   GET /api/painel?tipo=vencidas&minDias=1&maxDias=30 → parcelas em atraso
//
// Por que estão juntas: o plano Hobby do Vercel limita a 12 funções serverless
// por deployment, e já estávamos no teto. Estas duas eram as candidatas mais
// naturais a fundir — mesmo método, mesma autenticação, mesma natureza (leitura
// agregada para a secretaria) e nenhuma lógica compartilhada com o resto.
// Substituem api/dashboard.js e api/vencidas.js.

const { verificarRequisicaoComBanco, applyCors } = require('./_auth');
const { getPool, isDbUnavailable }               = require('./_db');

const TIPOS = ['dashboard', 'vencidas'];

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).json({ erro: 'Método não permitido' });

  // Autenticação antes de qualquer ramo
  const user = await verificarRequisicaoComBanco(req, res);
  if (!user) return;

  const tipo = (req.query?.tipo || '').trim();
  if (!TIPOS.includes(tipo))
    return res.status(400).json({ erro: `Parâmetro tipo inválido. Aceito: ${TIPOS.join(', ')}` });

  try {
    const pool = getPool();
    if (!pool) return res.status(503).json({ erro: 'Banco indisponível' });

    if (tipo === 'dashboard') return await dashboard(res, pool);
    return await vencidas(req, res, pool);
  } catch (err) {
    if (isDbUnavailable(err)) return res.status(503).json({ erro: 'Banco indisponível' });
    console.error('[painel]', err.message);
    return res.status(500).json({ erro: 'Erro interno' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/painel?tipo=dashboard
// ═══════════════════════════════════════════════════════════════════════════════
async function dashboard(res, pool) {
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
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/painel?tipo=vencidas
// ═══════════════════════════════════════════════════════════════════════════════
async function vencidas(req, res, pool) {
  const minDias = parseInt(req.query?.minDias) || 1;
  const maxDias = parseInt(req.query?.maxDias) || 9999;

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
}
