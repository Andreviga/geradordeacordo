'use strict';
// api/acordos/index.js  →  POST /api/acordos  |  GET /api/acordos

const { verificarRequisicaoComBanco, applyCors } = require('../_auth');
const { withTransaction, isDbUnavailable }        = require('../_db');

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const user = await verificarRequisicaoComBanco(req, res);
  if (!user) return;

  try {
    if (req.method === 'POST') return await salvar(req, res, user);
    if (req.method === 'GET')  return await listar(req, res);
    return res.status(405).json({ erro: 'Método não permitido' });
  } catch (err) {
    if (isDbUnavailable(err))
      return res.status(503).json({ erro: 'Banco indisponível', code: 'DB_UNAVAILABLE' });
    console.error('[acordos]', err.message);
    return res.status(500).json({ erro: 'Erro interno' });
  }
};

// ── POST /api/acordos ────────────────────────────────────────────────────────
async function salvar(req, res, user) {
  const b = req.body;
  if (!b || !Array.isArray(b.devedores) || !b.devedores.length)
    return res.status(400).json({ erro: 'Pelo menos um devedor é obrigatório' });
  if (!Array.isArray(b.parcelas) || !b.parcelas.length)
    return res.status(400).json({ erro: 'Parcelas são obrigatórias' });
  if (!b.acordo?.valorTotalCts || b.acordo.valorTotalCts <= 0)
    return res.status(400).json({ erro: 'Valor total inválido' });

  let resultado;
  try {
    resultado = await withTransaction(async (db) => {
      // Idempotência: se o cliente enviou uma chave e já existe acordo com ela, devolver o existente
      if (b.idempotencyKey) {
        const { rows: dup } = await db.query(
          'SELECT id, numero, atualizado_em FROM acordos WHERE idempotency_key = $1', [b.idempotencyKey]
        );
        if (dup.length > 0) return { id: dup[0].id, numero: dup[0].numero, atualizado_em: dup[0].atualizado_em, idempotente: true };
      }

      // 1. Devedores: CPF lookup, criar/reaproveitar, detectar divergência
      const devedoresSalvos = [];
      const divergencias    = [];
      const atualizarCPFs   = new Set(b.atualizarDevedores || []);
      // manterDevedores: usa dados do banco sem sobrescrever (opção "manter")
      const manterCPFs      = new Set(b.manterDevedores    || []);

      for (const d of b.devedores) {
        if (!d.cpf) throw Object.assign(new Error('CPF obrigatório para cada devedor'), { status: 400 });
        const { rows: ex } = await db.query(
          'SELECT * FROM devedores WHERE cpf = $1', [d.cpf]
        );

        if (ex.length > 0) {
          const atual = ex[0];
          const diff  = camposDivergentes(atual, d);

          if (diff.length > 0 && !atualizarCPFs.has(d.cpf) && !manterCPFs.has(d.cpf)) {
            // Divergência detectada, nenhuma decisão explícita → retornar 409
            divergencias.push({
              cpf:  d.cpf,
              diff, // [{ campo, label, antigo, novo }]
            });
            continue;
          }
          if (diff.length > 0 && atualizarCPFs.has(d.cpf)) {
            // Atualizar campos divergentes (ação explícita do usuário)
            await db.query(
              `UPDATE devedores SET nome=$1,rg=$2,rg_emissor=$3,nacionalidade=$4,
               estado_civil=$5,profissao=$6,end_logradouro=$7,end_cep=$8,
               end_cidade=$9,email=$10,telefone=$11,atualizado_em=NOW() WHERE id=$12`,
              [d.nome,d.rg||null,d.rgEmissor||null,d.nac||null,
               d.civil||null,d.prof||null,d.end||null,d.cep||null,
               d.cid||null,d.email||null,d.tel||null, atual.id]
            );
          }
          // "manter" ou dados idênticos → usa o devedor existente sem alteração
          devedoresSalvos.push({ id: atual.id, papel: d.papel || 'devedor', ordem: d.ordem || 1 });
        } else {
          const { rows: novo } = await db.query(
            `INSERT INTO devedores (nome,cpf,rg,rg_emissor,nacionalidade,estado_civil,profissao,
             end_logradouro,end_cep,end_cidade,email,telefone)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [d.nome,d.cpf,d.rg||null,d.rgEmissor||null,d.nac||null,
             d.civil||null,d.prof||null,d.end||null,d.cep||null,
             d.cid||null,d.email||null,d.tel||null]
          );
          devedoresSalvos.push({ id: novo[0].id, papel: d.papel || 'devedor', ordem: d.ordem || 1 });
        }
      }

      if (divergencias.length > 0)
        throw Object.assign(new Error('CPF_DIVERGENCIA'), { divergencias });

      // 2. Credoras: reaproveitar por CNPJ/CPF quando já existe
      const credorasSalvas = [];
      for (const c of (b.credoras || [])) {
        if (c.cnpj) {
          const { rows: ex } = await db.query(
            'SELECT id FROM credoras WHERE cnpj = $1', [c.cnpj]
          );
          if (ex.length > 0) {
            credorasSalvas.push({ id: ex[0].id, valorCts: c.valorCts || null, representante: c.rep || null, cargo: c.cargo || null });
            continue;
          }
        }
        const { rows: novo } = await db.query(
          `INSERT INTO credoras (nome,cnpj,tipo,end_logradouro,end_cidade,end_uf)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [c.nome,c.cnpj||null,c.tipo||'pj',c.end||null,c.cid||null,c.uf||null]
        );
        credorasSalvas.push({ id: novo[0].id, valorCts: c.valorCts || null, representante: c.rep || null, cargo: c.cargo || null });
      }

      // 3. Alunos: criar se não existir (sem chave de deduplicação natural)
      const alunosSalvos = [];
      for (const a of (b.alunos || [])) {
        const { rows: novo } = await db.query(
          `INSERT INTO alunos (nome,serie,turno,ra) VALUES ($1,$2,$3,$4) RETURNING id`,
          [a.nome, a.serie||null, a.turno||null, a.ra||null]
        );
        alunosSalvos.push(novo[0].id);
      }

      // 4. Número do acordo — INSERT ... ON CONFLICT DO UPDATE é atômico
      const ano = new Date().getFullYear();
      const { rows: numR } = await db.query(
        `INSERT INTO acordo_numero_seq (ano, ultimo) VALUES ($1, 1)
         ON CONFLICT (ano) DO UPDATE SET ultimo = acordo_numero_seq.ultimo + 1
         RETURNING ano, ultimo`,
        [ano]
      );
      const numero = `${numR[0].ano}/${String(numR[0].ultimo).padStart(3, '0')}`;

      // 5. Acordo (inclui idempotency_key para deduplicação futura)
      const a = b.acordo;
      const { rows: acR } = await db.query(
        `INSERT INTO acordos (numero,valor_total_cts,entrada_cts,n_parcelas,
          valor_parcela_cts,data_primeira_parcela,multa_mora_pct,juros_pct,
          multa_penal_pct,honorarios_pct,indice_correcao,origem_divida,
          periodo_referencia,foro,modo_assinatura,criado_por,idempotency_key,data_assinatura)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING id, atualizado_em`,
        [numero, a.valorTotalCts, a.entradaCts||0, a.nParcelas||null,
         a.valorParcelaCts||null, a.dataPrimeiraParcela||null,
         a.multaMoraPct||null, a.jurosPct||null, a.multaPenalPct||null,
         a.honorariosPct||null, a.indiceCorrecao||null,
         a.origemDivida||null, a.periodoReferencia||null, a.foro||null,
         a.modoAssinatura||'fisico', user.sub, b.idempotencyKey||null,
         a.dataAssinatura||null]
      );
      const acordoId = acR[0].id;

      // 6. Tabelas de junção
      for (const d of devedoresSalvos)
        await db.query(
          'INSERT INTO acordo_devedores (acordo_id,devedor_id,papel,ordem) VALUES ($1,$2,$3,$4)',
          [acordoId, d.id, d.papel, d.ordem]
        );
      for (const c of credorasSalvas)
        await db.query(
          'INSERT INTO acordo_credoras (acordo_id,credora_id,valor_cts,representante,cargo) VALUES ($1,$2,$3,$4,$5)',
          [acordoId, c.id, c.valorCts, c.representante, c.cargo]
        );
      for (const id of alunosSalvos)
        await db.query('INSERT INTO acordo_alunos (acordo_id,aluno_id) VALUES ($1,$2)', [acordoId, id]);

      // 7. Parcelas — tudo ou nada
      for (const p of b.parcelas)
        await db.query(
          'INSERT INTO parcelas (acordo_id,numero,vencimento,valor_previsto_cts) VALUES ($1,$2,$3,$4)',
          [acordoId, p.numero, p.vencimento, p.valorPrevistoCts]
        );

      return { id: acordoId, numero, atualizado_em: acR[0].atualizado_em };
    });
  } catch (err) {
    if (err.message === 'CPF_DIVERGENCIA')
      return res.status(409).json({ erro: 'CPF_DIVERGENCIA', divergencias: err.divergencias });
    if (err.status === 400)
      return res.status(400).json({ erro: err.message });
    throw err;
  }

  return res.status(201).json(resultado);
}

// ── GET /api/acordos ─────────────────────────────────────────────────────────
async function listar(req, res) {
  const busca  = (req.query?.busca  || '').trim() || null;
  const status = (req.query?.status || '').trim() || null;

  const { getPool } = require('../_db');
  const pool = getPool();
  if (!pool) return res.status(503).json({ erro: 'Banco indisponível' });

  const { rows } = await pool.query(
    `SELECT
       a.id, a.numero, a.criado_em, a.drive_file_id,
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
     LIMIT 100`,
    [busca, status]
  );

  return res.status(200).json({ acordos: rows });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const MAPA_CAMPOS = {
  nome:      { dbKey: 'nome',          label: 'Nome' },
  rg:        { dbKey: 'rg',            label: 'RG' },
  rgEmissor: { dbKey: 'rg_emissor',    label: 'Órgão emissor (RG)' },
  email:     { dbKey: 'email',         label: 'E-mail' },
  tel:       { dbKey: 'telefone',      label: 'Telefone' },
  end:       { dbKey: 'end_logradouro',label: 'Endereço' },
  cid:       { dbKey: 'end_cidade',    label: 'Cidade' },
};

// Retorna array de { campo, label, antigo, novo } para cada campo que diverge.
// Ignora campos em que qualquer um dos lados está vazio/null — sem sobrescrever
// com blank nem sobrescrever dado existente por erro de digitação.
function camposDivergentes(db, form) {
  const diff = [];
  for (const [fKey, { dbKey, label }] of Object.entries(MAPA_CAMPOS)) {
    const antigo = (db[dbKey]   || '').trim();
    const novo   = (form[fKey]  || '').trim();
    if (antigo && novo && antigo !== novo)
      diff.push({ campo: dbKey, label, antigo, novo });
  }
  return diff;
}

// Retorna apenas campos seguros para exibição no frontend (sem dados internos)
function sanitizarDevedor(d) {
  return {
    nome: d.nome, cpf: d.cpf, rg: d.rg, email: d.email,
    end_logradouro: d.end_logradouro, end_cidade: d.end_cidade,
  };
}
