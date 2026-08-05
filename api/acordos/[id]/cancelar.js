'use strict';
// api/acordos/[id]/cancelar.js  →  POST /api/acordos/:id/cancelar
// Cancelamento é soft-delete (cancelado=true). Nunca apaga dados.
// Restrito a admin. Motivo obrigatório — gravado em auditoria_exclusoes.

const { verificarRequisicaoComBanco, applyCors } = require('../../_auth');
const { withTransaction, isDbUnavailable, getPool } = require('../../_db');

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ erro: 'Método não permitido' });

  const user = await verificarRequisicaoComBanco(req, res);
  if (!user) return;

  if (user.papel !== 'admin')
    return res.status(403).json({ erro: 'Apenas administradores podem cancelar acordos' });

  const id = req.query?.id;
  if (!id || !/^[0-9a-f-]{36}$/.test(id))
    return res.status(400).json({ erro: 'ID inválido' });

  const motivo = (req.body?.motivo || '').trim();
  if (!motivo)
    return res.status(400).json({ erro: 'Motivo do cancelamento é obrigatório' });

  try {
    await withTransaction(async (db) => {
      const { rows } = await db.query(
        'SELECT id, cancelado FROM acordos WHERE id = $1', [id]
      );
      if (!rows[0])          throw Object.assign(new Error('Acordo não encontrado'), { status: 404 });
      if (rows[0].cancelado) throw Object.assign(new Error('Acordo já cancelado'),   { status: 409 });

      await db.query('UPDATE acordos SET cancelado = true WHERE id = $1', [id]);
      await db.query(
        `INSERT INTO auditoria_exclusoes (tabela, registro_id, excluido_por, motivo)
         VALUES ('acordos', $1, $2, $3)`,
        [id, user.sub, motivo]
      );
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    if (isDbUnavailable(err)) return res.status(503).json({ erro: 'Banco indisponível' });
    console.error('[cancelar]', err.message);
    return res.status(500).json({ erro: 'Erro interno' });
  }

  return res.status(200).json({ id, cancelado: true });
};
