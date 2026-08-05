'use strict';
// api/parcelas/[id]/estornar.js  →  POST /api/parcelas/:id/estornar
// Reverte uma baixa. Não apaga dados — registra em auditoria e zera valor_pago_cts.

const { verificarRequisicaoComBanco, applyCors } = require('../../../api/_auth');
const { withTransaction, isDbUnavailable }        = require('../../../api/_db');

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ erro: 'Método não permitido' });

  const user = await verificarRequisicaoComBanco(req, res);
  if (!user) return;

  const id = req.query?.id;
  if (!id || !/^[0-9a-f-]{36}$/.test(id))
    return res.status(400).json({ erro: 'ID de parcela inválido' });

  const motivo = (req.body?.motivo || '').trim();
  if (!motivo) return res.status(400).json({ erro: 'Motivo do estorno é obrigatório' });

  try {
    await withTransaction(async (db) => {
      const { rows } = await db.query(
        'SELECT * FROM parcelas WHERE id = $1 FOR UPDATE NOWAIT', [id]
      );
      if (!rows[0]) throw Object.assign(new Error('Parcela não encontrada'), { status: 404 });
      const p = rows[0];
      if (p.valor_pago_cts === null)
        throw Object.assign(new Error('Parcela não tem baixa registrada'), { status: 409 });

      // Gravar estorno e zerar pagamento; conservar o registro histórico nas colunas estorno*
      await db.query(
        `UPDATE parcelas SET
           estornado_em             = NOW(),
           estornado_por            = $1,
           motivo_estorno           = $2,
           -- reverter pagamento
           valor_pago_cts           = NULL,
           data_pagamento           = NULL,
           forma_pagamento          = NULL,
           referencia_pag           = NULL,
           tratamento_manual        = false,
           tratamento_manual_motivo = NULL
         WHERE id = $3`,
        [user.sub, motivo, id]
      );

      await db.query(
        `INSERT INTO auditoria_exclusoes (tabela, registro_id, excluido_por, motivo)
         VALUES ('baixas', $1, $2, $3)`,
        [id, user.sub, `Estorno: ${motivo}`]
      );
    });
  } catch (err) {
    if (err.code === '55P03') return res.status(409).json({ erro: 'Parcela em uso. Tente novamente.' });
    if (err.status) return res.status(err.status).json({ erro: err.message });
    if (isDbUnavailable(err)) return res.status(503).json({ erro: 'Banco indisponível' });
    console.error('[parcelas/estornar]', err.message);
    return res.status(500).json({ erro: 'Erro interno' });
  }

  return res.status(200).json({ ok: true, id });
};
