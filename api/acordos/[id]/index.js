'use strict';
// api/acordos/[id].js  →  GET /api/acordos/:id  |  DELETE /api/acordos/:id (cancelar, admin)

const { verificarRequisicaoComBanco, applyCors } = require('../../_auth');
const { withTransaction, isDbUnavailable, getPool } = require('../../_db');

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const user = await verificarRequisicaoComBanco(req, res);
  if (!user) return;

  const id = req.query?.id;
  if (!id || !/^[0-9a-f-]{36}$/.test(id))
    return res.status(400).json({ erro: 'ID inválido' });

  try {
    if (req.method === 'GET') return await buscar(req, res, id);
    if (req.method === 'PUT') return await atualizar(req, res, id, user);
    return res.status(405).json({ erro: 'Método não permitido. Para cancelar: POST /api/acordos/:id/cancelar' });
  } catch (err) {
    // FOR UPDATE NOWAIT: já tratado acima; capturar aqui por completude
    if (err.code === '55P03')
      throw Object.assign(new Error('Acordo em uso por outro usuário. Tente novamente.'), { status: 409 });
    if (err.status) return res.status(err.status).json({ erro: err.message, code: err.code });
    if (isDbUnavailable(err))
      return res.status(503).json({ erro: 'Banco indisponível' });
    console.error('[acordos/:id]', err.message);
    return res.status(500).json({ erro: 'Erro interno' });
  }
};

// PUT /api/acordos/:id — atualizar acordo não assinado com controle de concorrência
async function atualizar(req, res, id, user) {
  const b = req.body;
  if (!b?.acordo?.valorTotalCts)
    return res.status(400).json({ erro: 'Dados do acordo obrigatórios' });

  await withTransaction(async (db) => {
    // _versao obrigatório — sem ele o controle de concorrência não existe
    const versaoCliente = b._versao || b._atualizado_em;
    if (!versaoCliente)
      throw Object.assign(
        new Error('Campo _versao obrigatório. Recarregue o acordo e tente novamente.'),
        { status: 400, code: 'VERSAO_AUSENTE' }
      );

    // FOR UPDATE NOWAIT: falha rápido se a linha está bloqueada (evita fila de conexões)
    const { rows } = await db.query(
      'SELECT id, assinado_em, cancelado, atualizado_em FROM acordos WHERE id = $1 FOR UPDATE NOWAIT',
      [id]
    );
    if (!rows[0]) throw Object.assign(new Error('Acordo não encontrado'), { status: 404 });
    if (rows[0].cancelado) throw Object.assign(new Error('Não é possível editar acordo cancelado'), { status: 409 });
    if (rows[0].assinado_em)
      throw Object.assign(new Error('Não é possível editar acordo já assinado'), { status: 409 });

    const dbTs  = new Date(rows[0].atualizado_em).toISOString();
    const cliTs = new Date(versaoCliente).toISOString();
    if (dbTs !== cliTs)
      throw Object.assign(
        new Error('Acordo foi modificado por outro usuário. Recarregue e tente novamente.'),
        { status: 409, code: 'VERSAO_DESATUALIZADA' }
      );

    const a = b.acordo;
    await db.query(
      `UPDATE acordos SET valor_total_cts=$1,entrada_cts=$2,n_parcelas=$3,
        valor_parcela_cts=$4,data_primeira_parcela=$5,multa_mora_pct=$6,juros_pct=$7,
        multa_penal_pct=$8,honorarios_pct=$9,indice_correcao=$10,origem_divida=$11,
        periodo_referencia=$12,foro=$13,modo_assinatura=$14,atualizado_em=NOW()
       WHERE id=$15`,
      [a.valorTotalCts, a.entradaCts||0, a.nParcelas||null, a.valorParcelaCts||null,
       a.dataPrimeiraParcela||null, a.multaMoraPct||null, a.jurosPct||null,
       a.multaPenalPct||null, a.honorariosPct||null, a.indiceCorrecao||null,
       a.origemDivida||null, a.periodoReferencia||null, a.foro||null,
       a.modoAssinatura||'fisico', id]
    );

    await db.query('DELETE FROM parcelas WHERE acordo_id = $1', [id]);
    for (const p of (b.parcelas || []))
      await db.query(
        'INSERT INTO parcelas (acordo_id,numero,vencimento,valor_previsto_cts) VALUES ($1,$2,$3,$4)',
        [id, p.numero, p.vencimento, p.valorPrevistoCts]
      );
  });

  return res.status(200).json({ id, ok: true });
}

// GET /api/acordos/:id
async function buscar(req, res, id) {
  const pool = getPool();
  if (!pool) return res.status(503).json({ erro: 'Banco indisponível' });

  const { rows } = await pool.query(
    `SELECT a.*, acs.status, acs.saldo_total_cts, acs.proximo_vencimento,
       (SELECT JSON_AGG(JSON_BUILD_OBJECT(
           'id',d.id,'nome',d.nome,'cpf',d.cpf,'papel',ad.papel,'ordem',ad.ordem)
           ORDER BY ad.ordem)
        FROM acordo_devedores ad JOIN devedores d ON d.id = ad.devedor_id
        WHERE ad.acordo_id = a.id) AS devedores,
       (SELECT JSON_AGG(JSON_BUILD_OBJECT('id',c.id,'nome',c.nome,'cnpj',c.cnpj))
        FROM acordo_credoras ac JOIN credoras c ON c.id = ac.credora_id
        WHERE ac.acordo_id = a.id) AS credoras,
       (SELECT JSON_AGG(JSON_BUILD_OBJECT('id',al.id,'nome',al.nome,'serie',al.serie))
        FROM acordo_alunos aa JOIN alunos al ON al.id = aa.aluno_id
        WHERE aa.acordo_id = a.id) AS alunos,
       (SELECT JSON_AGG(p.* ORDER BY p.numero)
        FROM parcelas p WHERE p.acordo_id = a.id) AS parcelas
     FROM acordos_com_status acs JOIN acordos a ON a.id = acs.id
     WHERE a.id = $1`, [id]
  );

  if (!rows[0]) return res.status(404).json({ erro: 'Acordo não encontrado' });
  return res.status(200).json(rows[0]);
}

// Cancelamento — restrito a admin
async function cancelar(req, res, id, user) {
  if (user.papel !== 'admin')
    return res.status(403).json({ erro: 'Apenas administradores podem cancelar acordos' });

  const motivo = (req.body?.motivo || '').trim();
  if (!motivo)
    return res.status(400).json({ erro: 'Motivo do cancelamento é obrigatório' });

  await withTransaction(async (db) => {
    const { rows } = await db.query(
      'SELECT id, cancelado FROM acordos WHERE id = $1', [id]
    );
    if (!rows[0])      throw Object.assign(new Error('Não encontrado'), { status: 404 });
    if (rows[0].cancelado) throw Object.assign(new Error('Acordo já cancelado'), { status: 409 });

    await db.query('UPDATE acordos SET cancelado = true WHERE id = $1', [id]);
    await db.query(
      `INSERT INTO auditoria_exclusoes (tabela, registro_id, excluido_por, motivo)
       VALUES ('acordos', $1, $2, $3)`,
      [id, user.sub, motivo]
    );
  });

  return res.status(200).json({ ok: true, id });
}

