'use strict';
// api/acordos/[[...params]].js — catch-all para todas as rotas /api/acordos/*
// Substitui 5 funções serverless, mantendo URLs públicas idênticas.
//
// Roteamento:
//   GET  /api/acordos                  → listar
//   POST /api/acordos                  → salvar
//   POST /api/acordos/importar         → importar
//   GET  /api/acordos/:id              → buscar
//   PUT  /api/acordos/:id              → atualizar
//   POST /api/acordos/:id/cancelar     → cancelar (admin)
//   POST /api/acordos/:id/lembretes    → toggleLembretes
//
// Autenticação verificada UMA VEZ antes de qualquer ramo.
// Método ou caminho inválido → 405 ou 404 explícito.

const { verificarRequisicaoComBanco, applyCors } = require('../_auth');
const { withTransaction, getPool, isDbUnavailable } = require('../_db');

const isUUID = (s) => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── Autenticação — única vez, antes de qualquer ramo ─────────────────────
  const user = await verificarRequisicaoComBanco(req, res);
  if (!user) return;

  // ── Roteamento ────────────────────────────────────────────────────────────
  let params = Array.isArray(req.query.params) ? req.query.params
    : req.query.params ? [req.query.params] : [];
  // Fallback: extrair segmentos da URL quando Vercel não preenche req.query.params
  if (params.length === 0 && req.url) {
    const urlPath = (req.url || '').split('?')[0];
    const after = urlPath.replace(/^\/api\/acordos\/?/, '');
    if (after) params = after.split('/').filter(Boolean);
  }
  const [seg0, seg1, ...rest] = params;

  // Caminho com mais de 2 segmentos → 404
  if (rest.length > 0) return res.status(404).json({ erro: 'Rota não encontrada' });

  // seg1 só pode ser 'cancelar' ou 'lembretes'
  if (seg1 && seg1 !== 'cancelar' && seg1 !== 'lembretes')
    return res.status(404).json({ erro: 'Rota não encontrada' });

  // seg0 só pode ser UUID ou 'importar' (quando presente)
  if (seg0 && seg0 !== 'importar' && !isUUID(seg0))
    return res.status(404).json({ erro: 'Rota não encontrada' });

  try {
    // GET|POST /api/acordos
    if (params.length === 0) {
      if (req.method === 'GET')  return await listar(req, res);
      if (req.method === 'POST') return await salvar(req, res, user);
      return res.status(405).json({ erro: 'Método não permitido' });
    }

    // POST /api/acordos/importar
    if (params.length === 1 && seg0 === 'importar') {
      if (req.method === 'POST') return await importar(req, res, user);
      return res.status(405).json({ erro: 'Método não permitido' });
    }

    // GET|PUT /api/acordos/:id
    if (params.length === 1 && isUUID(seg0)) {
      if (req.method === 'GET') return await buscar(req, res, seg0);
      if (req.method === 'PUT') return await atualizar(req, res, seg0, user);
      return res.status(405).json({ erro: 'Método não permitido' });
    }

    // POST /api/acordos/:id/cancelar
    if (params.length === 2 && isUUID(seg0) && seg1 === 'cancelar') {
      if (req.method === 'POST') return await cancelar(req, res, seg0, user);
      return res.status(405).json({ erro: 'Método não permitido' });
    }

    // POST /api/acordos/:id/lembretes
    if (params.length === 2 && isUUID(seg0) && seg1 === 'lembretes') {
      if (req.method === 'POST') return await toggleLembretes(req, res, seg0, user);
      return res.status(405).json({ erro: 'Método não permitido' });
    }

    return res.status(404).json({ erro: 'Rota não encontrada' });
  } catch (err) {
    if (err.code === 'CPF_DIVERGENCIA')
      return res.status(409).json({ erro: 'CPF_DIVERGENCIA', divergencias: err.divergencias });
    if (err.code === 'NUMERO_DUPLICADO')
      return res.status(409).json({ erro: err.message, code: err.code });
    if (err.status) return res.status(err.status).json({ erro: err.message, code: err.code });
    if (isDbUnavailable(err)) return res.status(503).json({ erro: 'Banco indisponível', code: 'DB_UNAVAILABLE' });
    console.error('[acordos]', err.message);
    return res.status(500).json({ erro: 'Erro interno' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/acordos — listar
// ═══════════════════════════════════════════════════════════════════════════════
const LIMITE_PADRAO = 50;
const LIMITE_MAXIMO = 200;

async function listar(req, res) {
  const busca  = (req.query?.busca  || '').trim() || null;
  const status = (req.query?.status || '').trim() || null;
  // Antes havia um LIMIT 100 fixo e sem contagem: passado o centésimo acordo, os
  // demais simplesmente sumiam da tela, sem nada indicando que existiam.
  const limite = Math.min(Math.max(parseInt(req.query?.limite, 10) || LIMITE_PADRAO, 1), LIMITE_MAXIMO);
  const pagina = Math.max(parseInt(req.query?.pagina, 10) || 1, 1);
  const pool = getPool();
  if (!pool) return res.status(503).json({ erro: 'Banco indisponível' });

  const { rows } = await pool.query(
    `SELECT
       a.id, a.numero, a.criado_em, a.drive_file_id, a.lembretes_ativos,
       acs.status, acs.saldo_total_cts, acs.proximo_vencimento,
       (SELECT STRING_AGG(d.nome, ', ' ORDER BY ad.ordem)
        FROM acordo_devedores ad JOIN devedores d ON d.id = ad.devedor_id
        WHERE ad.acordo_id = a.id) AS devedores,
       (SELECT STRING_AGG(al.nome, ', ')
        FROM acordo_alunos aa JOIN alunos al ON al.id = aa.aluno_id
        WHERE aa.acordo_id = a.id) AS alunos
     FROM acordos_com_status acs JOIN acordos a ON a.id = acs.id
     WHERE (
       $1::text IS NULL OR
       EXISTS (SELECT 1 FROM acordo_devedores ad2 JOIN devedores d2 ON d2.id = ad2.devedor_id
               WHERE ad2.acordo_id = a.id
                 AND (d2.nome ILIKE '%'||$1||'%' OR d2.cpf ILIKE '%'||REPLACE($1,'.','.')||'%'))
       OR EXISTS (SELECT 1 FROM acordo_alunos aa2 JOIN alunos al2 ON al2.id = aa2.aluno_id
                  WHERE aa2.acordo_id = a.id AND al2.nome ILIKE '%'||$1||'%')
     )
     AND ($2::text IS NULL OR acs.status = $2::text)
     ORDER BY acs.proximo_vencimento NULLS LAST, a.criado_em DESC
     LIMIT $3 OFFSET $4`,
    [busca, status, limite, (pagina - 1) * limite]
  );

  // Mesmo filtro da consulta acima, só que contando — para a tela poder dizer
  // "mostrando 50 de 347" em vez de calar sobre o resto.
  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM acordos_com_status acs JOIN acordos a ON a.id = acs.id
     WHERE (
       $1::text IS NULL OR
       EXISTS (SELECT 1 FROM acordo_devedores ad2 JOIN devedores d2 ON d2.id = ad2.devedor_id
               WHERE ad2.acordo_id = a.id
                 AND (d2.nome ILIKE '%'||$1||'%' OR d2.cpf ILIKE '%'||REPLACE($1,'.','.')||'%'))
       OR EXISTS (SELECT 1 FROM acordo_alunos aa2 JOIN alunos al2 ON al2.id = aa2.aluno_id
                  WHERE aa2.acordo_id = a.id AND al2.nome ILIKE '%'||$1||'%')
     )
     AND ($2::text IS NULL OR acs.status = $2::text)`,
    [busca, status]
  );

  return res.status(200).json({
    acordos: rows,
    total: cnt[0].total,
    pagina,
    limite,
    paginas: Math.max(1, Math.ceil(cnt[0].total / limite)),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/acordos — salvar
// ═══════════════════════════════════════════════════════════════════════════════
async function salvar(req, res, user) {
  const b = req.body;
  if (!b || !Array.isArray(b.devedores) || !b.devedores.length)
    return res.status(400).json({ erro: 'Pelo menos um devedor é obrigatório' });
  if (!Array.isArray(b.parcelas) || !b.parcelas.length)
    return res.status(400).json({ erro: 'Parcelas são obrigatórias' });
  if (!b.acordo?.valorTotalCts || b.acordo.valorTotalCts <= 0)
    return res.status(400).json({ erro: 'Valor total inválido' });

  const resultado = await withTransaction(async (db) => {
    if (b.idempotencyKey) {
      const { rows: dup } = await db.query(
        'SELECT id, numero, atualizado_em FROM acordos WHERE idempotency_key = $1', [b.idempotencyKey]
      );
      if (dup.length > 0) return { id: dup[0].id, numero: dup[0].numero, atualizado_em: dup[0].atualizado_em, idempotente: true };
    }

    const { devedoresSalvos, divergencias } = await processarDevedores(db, b.devedores, b.atualizarDevedores, b.manterDevedores);
    if (divergencias.length > 0) throw Object.assign(new Error('CPF_DIVERGENCIA'), { code: 'CPF_DIVERGENCIA', divergencias });

    const credorasSalvas = await processarCredoras(db, b.credoras || []);
    const alunosSalvos   = await processarAlunos(db, b.alunos || []);

    const ano = new Date().getFullYear();
    const { rows: numR } = await db.query(
      `INSERT INTO acordo_numero_seq (ano, ultimo) VALUES ($1, 1)
       ON CONFLICT (ano) DO UPDATE SET ultimo = acordo_numero_seq.ultimo + 1
       RETURNING ano, ultimo`, [ano]
    );
    const numero = `${numR[0].ano}/${String(numR[0].ultimo).padStart(3, '0')}`;

    const a = b.acordo;
    const { rows: acR } = await db.query(
      `INSERT INTO acordos (numero,valor_total_cts,entrada_cts,n_parcelas,valor_parcela_cts,
        data_primeira_parcela,multa_mora_pct,juros_pct,multa_penal_pct,honorarios_pct,
        indice_correcao,origem_divida,periodo_referencia,foro,modo_assinatura,criado_por,
        idempotency_key,data_assinatura)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id, atualizado_em`,
      [numero, a.valorTotalCts, a.entradaCts||0, a.nParcelas||null, a.valorParcelaCts||null,
       a.dataPrimeiraParcela||null, a.multaMoraPct||null, a.jurosPct||null, a.multaPenalPct||null,
       a.honorariosPct||null, a.indiceCorrecao||null, a.origemDivida||null, a.periodoReferencia||null,
       a.foro||null, a.modoAssinatura||'fisico', user.sub, b.idempotencyKey||null, a.dataAssinatura||null]
    );
    const acordoId = acR[0].id;

    for (const d of devedoresSalvos)
      await db.query('INSERT INTO acordo_devedores (acordo_id,devedor_id,papel,ordem) VALUES ($1,$2,$3,$4)',
        [acordoId, d.id, d.papel, d.ordem]);
    for (const c of credorasSalvas)
      await db.query('INSERT INTO acordo_credoras (acordo_id,credora_id,valor_cts,representante,cargo) VALUES ($1,$2,$3,$4,$5)',
        [acordoId, c.id, c.valorCts, c.representante, c.cargo]);
    for (const id of alunosSalvos)
      await db.query('INSERT INTO acordo_alunos (acordo_id,aluno_id) VALUES ($1,$2)', [acordoId, id]);
    for (const p of b.parcelas)
      await db.query('INSERT INTO parcelas (acordo_id,numero,vencimento,valor_previsto_cts) VALUES ($1,$2,$3,$4)',
        [acordoId, p.numero, p.vencimento, p.valorPrevistoCts]);

    return { id: acordoId, numero, atualizado_em: acR[0].atualizado_em };
  });

  return res.status(201).json(resultado);
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/acordos/importar — cadastro retroativo
// ═══════════════════════════════════════════════════════════════════════════════
async function importar(req, res, user) {
  const b = req.body;
  if (!Array.isArray(b.devedores) || !b.devedores.length)
    return res.status(400).json({ erro: 'Pelo menos um devedor é obrigatório' });
  if (!b.acordo?.valorTotalCts || b.acordo.valorTotalCts <= 0)
    return res.status(400).json({ erro: 'valorTotalCts obrigatório e positivo' });
  if (!Array.isArray(b.parcelas) || !b.parcelas.length)
    return res.status(400).json({ erro: 'Pelo menos uma parcela é obrigatória' });

  const resultado = await withTransaction(async (db) => {
    const { devedoresSalvos, divergencias } = await processarDevedores(db, b.devedores, b.atualizarDevedores, b.manterDevedores);
    if (divergencias.length > 0) throw Object.assign(new Error('CPF_DIVERGENCIA'), { code: 'CPF_DIVERGENCIA', divergencias });

    const a = b.acordo;
    let numero = a.numero?.trim() || null;
    if (numero) {
      const { rows: dup } = await db.query('SELECT id FROM acordos WHERE numero = $1', [numero]);
      if (dup.length > 0)
        throw Object.assign(new Error(`Número "${numero}" já existe. Altere ou omita para gerar automaticamente.`),
          { status: 409, code: 'NUMERO_DUPLICADO' });
    } else {
      const anoRef = a.dataAssinatura ? parseInt(a.dataAssinatura.slice(0, 4), 10) : new Date().getFullYear();
      const { rows: numR } = await db.query(
        `INSERT INTO acordo_numero_seq (ano, ultimo) VALUES ($1, 1)
         ON CONFLICT (ano) DO UPDATE SET ultimo = acordo_numero_seq.ultimo + 1
         RETURNING ano, ultimo`, [anoRef]
      );
      numero = `${numR[0].ano}/${String(numR[0].ultimo).padStart(3, '0')}`;
    }

    const credorasSalvas = await processarCredoras(db, b.credoras || []);
    const alunosSalvos   = await processarAlunos(db, b.alunos || []);

    const { rows: acR } = await db.query(
      `INSERT INTO acordos (numero,valor_total_cts,entrada_cts,n_parcelas,valor_parcela_cts,
        data_primeira_parcela,multa_mora_pct,juros_pct,multa_penal_pct,honorarios_pct,
        indice_correcao,origem_divida,periodo_referencia,foro,modo_assinatura,criado_por,
        data_assinatura,lembretes_ativos,lembretes_desativado_por,snapshot_assinatura_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,false,$18,null)
       RETURNING id, atualizado_em`,
      [numero, a.valorTotalCts, a.entradaCts||0, a.nParcelas||null, a.valorParcelaCts||null,
       a.dataPrimeiraParcela||null, a.multaMoraPct||null, a.jurosPct||null, a.multaPenalPct||null,
       a.honorariosPct||null, a.indiceCorrecao||null, a.origemDivida||null, a.periodoReferencia||null,
       a.foro||null, 'fisico', user.sub, a.dataAssinatura||null, 'importacao_retroativa']
    );
    const acordoId = acR[0].id;

    for (const d of devedoresSalvos)
      await db.query('INSERT INTO acordo_devedores (acordo_id,devedor_id,papel,ordem) VALUES ($1,$2,$3,$4)',
        [acordoId, d.id, d.papel, d.ordem]);
    for (const c of credorasSalvas)
      await db.query('INSERT INTO acordo_credoras (acordo_id,credora_id,valor_cts,representante,cargo) VALUES ($1,$2,$3,$4,$5)',
        [acordoId, c.id, c.valorCts, c.representante, c.cargo]);
    for (const id of alunosSalvos)
      await db.query('INSERT INTO acordo_alunos (acordo_id,aluno_id) VALUES ($1,$2)', [acordoId, id]);
    for (const p of b.parcelas) {
      const previsto = Number(p.valorPrevistoCts);
      const pago     = p.valorPagoCts != null ? Number(p.valorPagoCts) : null;
      const parcial  = pago !== null && pago < previsto;
      await db.query(
        `INSERT INTO parcelas (acordo_id,numero,vencimento,valor_previsto_cts,valor_pago_cts,
          data_pagamento,forma_pagamento,referencia_pag,observacao,registrado_por,
          renegociada,tratamento_manual,tratamento_manual_motivo,classificacao_excedente)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [acordoId, p.numero, p.vencimento, previsto, pago, p.dataPagamento||null,
         p.formaPagamento||null, p.referencia||null, p.observacao||null,
         pago != null ? user.sub : null, p.renegociada||false,
         parcial, parcial ? 'pagamento parcial' : null, p.classificacaoExcedente||null]
      );
    }
    return { id: acordoId, numero, atualizado_em: acR[0].atualizado_em, lembretesAtivos: false };
  });

  // Upload PDF ao Drive (opcional, não bloqueia resposta)
  if (b.pdfBase64 && process.env.GOOGLE_SERVICE_ACCOUNT_JSON && resultado.id) {
    uploadPdfToDrive(b.pdfBase64, `${resultado.numero}.pdf`)
      .then(driveFileid => {
        if (driveFileid) getPool()?.query('UPDATE acordos SET drive_file_id=$1 WHERE id=$2', [driveFileid, resultado.id]);
      }).catch(e => console.warn('[importar] PDF upload falhou:', e.message));
  }
  return res.status(201).json(resultado);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/acordos/:id — buscar
// ═══════════════════════════════════════════════════════════════════════════════
async function buscar(req, res, id) {
  const pool = getPool();
  if (!pool) return res.status(503).json({ erro: 'Banco indisponível' });
  const { rows } = await pool.query(
    `SELECT a.*, acs.status, acs.saldo_total_cts, acs.proximo_vencimento,
       (SELECT JSON_AGG(JSON_BUILD_OBJECT('id',d.id,'nome',d.nome,'cpf',d.cpf,'papel',ad.papel,'ordem',ad.ordem)
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

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /api/acordos/:id — atualizar
// ═══════════════════════════════════════════════════════════════════════════════
async function atualizar(req, res, id, user) {
  const b = req.body;
  if (!b?.acordo?.valorTotalCts) return res.status(400).json({ erro: 'Dados do acordo obrigatórios' });

  const versaoCliente = b._versao || b._atualizado_em;
  if (!versaoCliente)
    return res.status(400).json({ erro: 'Campo _versao obrigatório. Recarregue o acordo e tente novamente.', code: 'VERSAO_AUSENTE' });

  const novasParcelas = Array.isArray(b.parcelas) ? b.parcelas : [];
  if (novasParcelas.some(p => !Number.isInteger(Number(p.numero)) || Number(p.numero) <= 0))
    return res.status(400).json({ erro: 'Cada parcela precisa de numero inteiro positivo' });

  await withTransaction(async (db) => {
    const { rows } = await db.query(
      'SELECT id, assinado_em, cancelado, atualizado_em FROM acordos WHERE id = $1 FOR UPDATE NOWAIT', [id]
    );
    if (!rows[0]) throw Object.assign(new Error('Acordo não encontrado'), { status: 404 });
    if (rows[0].cancelado) throw Object.assign(new Error('Não é possível editar acordo cancelado'), { status: 409 });
    if (rows[0].assinado_em) throw Object.assign(new Error('Não é possível editar acordo já assinado'), { status: 409 });

    const dbTs = new Date(rows[0].atualizado_em).toISOString();
    const cliTs = new Date(versaoCliente).toISOString();
    if (dbTs !== cliTs)
      throw Object.assign(new Error('Acordo foi modificado por outro usuário. Recarregue e tente novamente.'),
        { status: 409, code: 'VERSAO_DESATUALIZADA' });

    const a = b.acordo;
    await db.query(
      `UPDATE acordos SET valor_total_cts=$1,entrada_cts=$2,n_parcelas=$3,valor_parcela_cts=$4,
        data_primeira_parcela=$5,multa_mora_pct=$6,juros_pct=$7,multa_penal_pct=$8,
        honorarios_pct=$9,indice_correcao=$10,origem_divida=$11,periodo_referencia=$12,
        foro=$13,modo_assinatura=$14,atualizado_em=NOW() WHERE id=$15`,
      [a.valorTotalCts, a.entradaCts||0, a.nParcelas||null, a.valorParcelaCts||null,
       a.dataPrimeiraParcela||null, a.multaMoraPct||null, a.jurosPct||null, a.multaPenalPct||null,
       a.honorariosPct||null, a.indiceCorrecao||null, a.origemDivida||null, a.periodoReferencia||null,
       a.foro||null, a.modoAssinatura||'fisico', id]
    );
    // ── Parcelas: upsert por (acordo_id, numero) — nunca DELETE cego ────────
    // valor_pago_cts, data_pagamento, forma_pagamento, registrado_por e os campos
    // de estorno são FATOS registrados na baixa. Um DELETE+INSERT aqui apagaria
    // silenciosamente o histórico de pagamento ao editar um vencimento — e nada
    // no sistema escreve em assinado_em, então a trava acima nunca protegeu
    // acordos físicos nem importações retroativas (que já nascem com baixas).
    const numeros = novasParcelas.map(p => Number(p.numero));

    const { rows: pagasRemovidas } = await db.query(
      `SELECT numero FROM parcelas
        WHERE acordo_id = $1 AND valor_pago_cts IS NOT NULL
          AND NOT (numero = ANY($2::int[]))
        ORDER BY numero`, [id, numeros]
    );
    if (pagasRemovidas.length > 0)
      throw Object.assign(
        new Error(`Parcela(s) ${pagasRemovidas.map(r => r.numero).join(', ')} têm pagamento registrado e não podem ser removidas. Estorne a baixa antes de editar.`),
        { status: 409, code: 'PARCELA_PAGA_REMOVIDA' }
      );

    await db.query(
      'DELETE FROM parcelas WHERE acordo_id = $1 AND NOT (numero = ANY($2::int[]))', [id, numeros]
    );

    for (const p of novasParcelas)
      await db.query(
        `INSERT INTO parcelas (acordo_id,numero,vencimento,valor_previsto_cts) VALUES ($1,$2,$3,$4)
         ON CONFLICT (acordo_id, numero) DO UPDATE
           SET vencimento = EXCLUDED.vencimento,
               valor_previsto_cts = EXCLUDED.valor_previsto_cts`,
        [id, p.numero, p.vencimento, p.valorPrevistoCts]
      );
  });
  return res.status(200).json({ id, ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/acordos/:id/cancelar — cancelar (admin)
// ═══════════════════════════════════════════════════════════════════════════════
async function cancelar(req, res, id, user) {
  if (user.papel !== 'admin')
    return res.status(403).json({ erro: 'Apenas administradores podem cancelar acordos' });

  const motivo = (req.body?.motivo || '').trim();
  if (!motivo) return res.status(400).json({ erro: 'Motivo do cancelamento é obrigatório' });

  await withTransaction(async (db) => {
    const { rows } = await db.query('SELECT id, cancelado FROM acordos WHERE id = $1', [id]);
    if (!rows[0])          throw Object.assign(new Error('Acordo não encontrado'), { status: 404 });
    if (rows[0].cancelado) throw Object.assign(new Error('Acordo já cancelado'),   { status: 409 });
    await db.query('UPDATE acordos SET cancelado = true WHERE id = $1', [id]);
    await db.query(
      `INSERT INTO auditoria_exclusoes (tabela, registro_id, excluido_por, motivo)
       VALUES ('acordos', $1, $2, $3)`, [id, user.sub, motivo]
    );
  });
  return res.status(200).json({ id, cancelado: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/acordos/:id/lembretes — ativar/desativar
// ═══════════════════════════════════════════════════════════════════════════════
async function toggleLembretes(req, res, id, user) {
  const { ativo } = req.body || {};
  if (typeof ativo !== 'boolean')
    return res.status(400).json({ erro: 'Campo ativo (boolean) obrigatório' });

  await withTransaction(async (db) => {
    const { rows } = await db.query('SELECT id, cancelado FROM acordos WHERE id = $1', [id]);
    if (!rows[0])          throw Object.assign(new Error('Acordo não encontrado'), { status: 404 });
    if (rows[0].cancelado) throw Object.assign(new Error('Acordo cancelado'), { status: 409 });
    await db.query(
      `UPDATE acordos SET lembretes_ativos=$1, lembretes_desativado_por=$2 WHERE id=$3`,
      [ativo, ativo ? null : `${user.papel}:${user.email || user.sub}`, id]
    );
  });
  return res.status(200).json({ id, lembretes_ativos: ativo });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers compartilhados
// ═══════════════════════════════════════════════════════════════════════════════
const MAPA_DEV = { nome:'nome', rg:'rg', rgEmissor:'rg_emissor', email:'email',
                   tel:'telefone', end:'end_logradouro', cid:'end_cidade' };

function camposDivergentes(db, form) {
  return Object.entries(MAPA_DEV).reduce((diff, [fKey, dbKey]) => {
    const a = (db[dbKey] || '').trim(), b = (form[fKey] || '').trim();
    if (a && b && a !== b) diff.push({ campo: dbKey, label: dbKey, antigo: a, novo: b });
    return diff;
  }, []);
}

async function processarDevedores(db, lista, atualizarCPFs = [], manterCPFs = []) {
  const aSet = new Set(atualizarCPFs), mSet = new Set(manterCPFs);
  const devedoresSalvos = [], divergencias = [];
  for (let i = 0; i < lista.length; i++) {
    const d = lista[i];
    if (!d.cpf) throw Object.assign(new Error('CPF obrigatório para cada devedor'), { status: 400 });
    const { rows: ex } = await db.query('SELECT * FROM devedores WHERE cpf = $1', [d.cpf]);
    if (ex.length > 0) {
      const atual = ex[0], diff = camposDivergentes(atual, d);
      if (diff.length > 0 && !aSet.has(d.cpf) && !mSet.has(d.cpf)) {
        divergencias.push({ cpf: d.cpf, diff }); continue;
      }
      if (diff.length > 0 && aSet.has(d.cpf))
        await db.query(
          `UPDATE devedores SET nome=$1,rg=$2,rg_emissor=$3,nacionalidade=$4,estado_civil=$5,profissao=$6,
           end_logradouro=$7,end_cep=$8,end_cidade=$9,email=$10,telefone=$11,atualizado_em=NOW() WHERE id=$12`,
          [d.nome,d.rg||null,d.rgEmissor||null,d.nac||null,d.civil||null,d.prof||null,
           d.end||null,d.cep||null,d.cid||null,d.email||null,d.tel||null,atual.id]
        );
      devedoresSalvos.push({ id: atual.id, papel: d.papel||'devedor', ordem: d.ordem||i+1 });
    } else {
      const { rows: novo } = await db.query(
        `INSERT INTO devedores (nome,cpf,rg,rg_emissor,nacionalidade,estado_civil,profissao,
         end_logradouro,end_cep,end_cidade,email,telefone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [d.nome,d.cpf,d.rg||null,d.rgEmissor||null,d.nac||null,d.civil||null,d.prof||null,
         d.end||null,d.cep||null,d.cid||null,d.email||null,d.tel||null]
      );
      devedoresSalvos.push({ id: novo[0].id, papel: d.papel||'devedor', ordem: d.ordem||i+1 });
    }
  }
  return { devedoresSalvos, divergencias };
}

async function processarCredoras(db, lista) {
  const out = [];
  for (const c of lista) {
    let credoraId;
    if (c.cnpj) {
      const { rows: ex } = await db.query('SELECT id FROM credoras WHERE cnpj = $1', [c.cnpj]);
      if (ex.length > 0) credoraId = ex[0].id;
    }
    if (!credoraId) {
      const { rows: novo } = await db.query(
        `INSERT INTO credoras (nome,cnpj,tipo,end_logradouro,end_cidade,end_uf) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [c.nome,c.cnpj||null,c.tipo||'pj',c.end||null,c.cid||null,c.uf||null]
      );
      credoraId = novo[0].id;
    }
    out.push({ id: credoraId, valorCts: c.valorCts||null, representante: c.rep||null, cargo: c.cargo||null });
  }
  return out;
}

// Reaproveita o aluno já cadastrado em vez de inserir sempre. Antes, cada
// salvamento criava linhas novas: reabrir e salvar o mesmo acordo duplicava os
// alunos, e um irmão em dois acordos virava dois cadastros.
//
// Chave: o RA quando existe (é o identificador do colégio, sem ambiguidade).
// Sem RA, cai para nome + série, que é o que a secretaria tem em mãos. Dois
// alunos homônimos na mesma série passariam a compartilhar cadastro — o custo
// disso é a listagem de beneficiários, não valor nenhum, e é bem menos provável
// que a duplicação garantida de antes.
async function processarAlunos(db, lista) {
  const out = [];
  for (const al of lista) {
    const nome = (al.nome || '').trim();
    const ra   = (al.ra   || '').trim();
    if (!nome) throw Object.assign(new Error('Nome do aluno é obrigatório'), { status: 400 });

    const { rows: ex } = ra
      ? await db.query('SELECT id FROM alunos WHERE ra = $1', [ra])
      : await db.query(
          `SELECT id FROM alunos
           WHERE LOWER(nome) = LOWER($1) AND COALESCE(serie,'') = COALESCE($2,'') AND ra IS NULL`,
          [nome, al.serie || null]);

    if (ex.length > 0) {
      // Série e turno mudam a cada ano letivo; o cadastro acompanha
      await db.query('UPDATE alunos SET serie = $1, turno = $2 WHERE id = $3',
        [al.serie || null, al.turno || null, ex[0].id]);
      out.push(ex[0].id);
      continue;
    }

    const { rows: novo } = await db.query(
      'INSERT INTO alunos (nome,serie,turno,ra) VALUES ($1,$2,$3,$4) RETURNING id',
      [nome, al.serie || null, al.turno || null, ra || null]
    );
    out.push(novo[0].id);
  }
  return out;
}

// Upload PDF ao Drive (copiado de importar.js original)
async function uploadPdfToDrive(base64, nome) {
  const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const folderId = process.env.DRIVE_PDF_FOLDER_ID;
  if (!saRaw || !folderId) return null;
  const text = saRaw.startsWith('{') ? saRaw : Buffer.from(saRaw, 'base64').toString('utf8');
  const sa   = JSON.parse(text);
  const crypto = require('crypto');
  const now    = Math.floor(Date.now() / 1000);
  const hdr    = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const pay    = Buffer.from(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })).toString('base64url');
  const sig = crypto.createSign('RSA-SHA256').update(`${hdr}.${pay}`).sign(sa.private_key, 'base64url');
  const tokR = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${hdr}.${pay}.${sig}` }),
  });
  const { access_token } = await tokR.json();
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name: nome, parents: [folderId] })], { type: 'application/json' }));
  form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: 'application/pdf' }));
  const up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
    { method: 'POST', headers: { Authorization: `Bearer ${access_token}` }, body: form });
  const { id } = await up.json();
  return id || null;
}
