'use strict';
// api/parcelas/[[...params]].js — catch-all para /api/parcelas/*
// Substitui 2 funções serverless, mantendo URLs públicas idênticas.
//
// Roteamento:
//   POST /api/parcelas/:id/baixar    → baixar
//   POST /api/parcelas/:id/estornar  → estornar
//
// Autenticação verificada uma vez antes de qualquer ramo.

const { verificarRequisicaoComBanco, applyCors } = require('../_auth');
const { withTransaction, isDbUnavailable }        = require('../_db');

const isUUID = (s) => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
const FORMAS  = ['pix','ted','boleto','especie','cartao','cheque','outro'];
const CLASSIF = ['encargos_atraso','adiantamento_parcela','erro_verificar'];

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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
    const after = (req.url || '').split('?')[0].replace(/^\/api\/parcelas\/?/, '');
    if (after) params = after.split('/').filter(Boolean);
  }
  const [seg0, seg1, ...rest] = params;

  if (rest.length > 0) return res.status(404).json({ erro: 'Rota não encontrada' });
  if (!isUUID(seg0))   return res.status(400).json({ erro: 'ID de parcela inválido' });
  if (!seg1 || (seg1 !== 'baixar' && seg1 !== 'estornar'))
    return res.status(404).json({ erro: 'Rota não encontrada' });
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  try {
    if (seg1 === 'baixar')   return await baixar(req, res, seg0, user);
    if (seg1 === 'estornar') return await estornar(req, res, seg0, user);
  } catch (err) {
    if (err.code === '55P03') return res.status(409).json({ erro: 'Parcela em uso. Tente novamente.', code: 'LOCK_NAO_DISPONIVEL' });
    if (err.status) return res.status(err.status).json({ erro: err.message, code: err.code });
    if (isDbUnavailable(err)) return res.status(503).json({ erro: 'Banco indisponível' });
    console.error('[parcelas]', err.message);
    return res.status(500).json({ erro: 'Erro interno' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/parcelas/:id/baixar
// ═══════════════════════════════════════════════════════════════════════════════
async function baixar(req, res, id, user) {
  const b = req.body || {};
  const valorPagoCts = Number.isInteger(b.valorPagoCts)
    ? b.valorPagoCts : (b.valorPagoCts != null ? parseInt(b.valorPagoCts, 10) : NaN);
  if (!Number.isInteger(valorPagoCts) || valorPagoCts <= 0)
    return res.status(400).json({ erro: 'valorPagoCts deve ser inteiro positivo (em centavos)' });
  if (!b.dataPagamento || !/^\d{4}-\d{2}-\d{2}$/.test(b.dataPagamento))
    return res.status(400).json({ erro: 'dataPagamento obrigatório no formato AAAA-MM-DD' });
  if (b.dataPagamento > new Date().toISOString().slice(0, 10))
    return res.status(400).json({ erro: 'Data de pagamento não pode ser futura' });
  if (b.formaPagamento && !FORMAS.includes(b.formaPagamento))
    return res.status(400).json({ erro: `formaPagamento inválida. Aceito: ${FORMAS.join(', ')}` });
  if (b.classificacaoExcedente && !CLASSIF.includes(b.classificacaoExcedente))
    return res.status(400).json({ erro: `classificacaoExcedente inválida. Aceito: ${CLASSIF.join(', ')}` });

  const resultado = await withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT p.*, a.cancelado, a.assinado_em, a.criado_em, a.data_assinatura
       FROM parcelas p JOIN acordos a ON a.id = p.acordo_id
       WHERE p.id = $1 FOR UPDATE NOWAIT`, [id]
    );
    if (!rows[0]) throw Object.assign(new Error('Parcela não encontrada'), { status: 404 });
    const p = rows[0];
    if (p.cancelado)   throw Object.assign(new Error('Acordo cancelado'), { status: 409 });
    if (p.renegociada) throw Object.assign(new Error('Parcela renegociada não aceita baixa'), { status: 409 });

    const dtRef = (p.data_assinatura || p.criado_em) instanceof Date
      ? (p.data_assinatura || p.criado_em).toISOString().slice(0, 10)
      : String(p.data_assinatura || p.criado_em).slice(0, 10);
    if (b.dataPagamento < dtRef)
      throw Object.assign(new Error(`Data de pagamento (${b.dataPagamento}) anterior à data do acordo (${dtRef}).`),
        { status: 400, code: 'DATA_ANTERIOR_ACORDO' });

    const previstoCts = Number(p.valor_previsto_cts);
    const excedente   = Math.max(0, valorPagoCts - previstoCts);

    if (valorPagoCts > 2 * previstoCts && !b.confirmarValorExcessivo)
      throw Object.assign(new Error(`Valor (${valorPagoCts} cts) excede o dobro do previsto (${previstoCts} cts). Envie confirmarValorExcessivo:true se correto.`),
        { status: 400, code: 'VALOR_SUSPEITO' });

    if (p.valor_pago_cts !== null && !b.confirmarSobrescrita)
      throw Object.assign(new Error('Esta parcela já tem pagamento registrado. Envie confirmarSobrescrita:true para substituir.'),
        { status: 409, code: 'PARCELA_JA_PAGA' });

    const parcial = valorPagoCts < previstoCts;
    const tmMotivoAtual = p.tratamento_manual_motivo;
    const novoTmMotivo  = !parcial ? null
      : (tmMotivoAtual && tmMotivoAtual !== 'pagamento parcial' ? tmMotivoAtual : 'pagamento parcial');

    await db.query(
      `UPDATE parcelas SET valor_pago_cts=$1, data_pagamento=$2, forma_pagamento=$3,
         referencia_pag=$4, observacao=$5, registrado_por=$6,
         tratamento_manual=$7, tratamento_manual_motivo=$8,
         classificacao_excedente=$9,
         estornado_em=NULL, estornado_por=NULL, motivo_estorno=NULL
       WHERE id=$10`,
      [valorPagoCts, b.dataPagamento, b.formaPagamento||null,
       b.referencia||null, b.observacao||null, user.sub,
       parcial, novoTmMotivo,
       excedente > 0 ? (b.classificacaoExcedente||null) : null,
       id]
    );
    return { id, saldoCts: Math.max(0, previstoCts - valorPagoCts), valorExcedenteCts: excedente, parcial };
  });
  return res.status(200).json({ ok: true, ...resultado });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/parcelas/:id/estornar
// ═══════════════════════════════════════════════════════════════════════════════
async function estornar(req, res, id, user) {
  const motivo = (req.body?.motivo || '').trim();
  if (!motivo) return res.status(400).json({ erro: 'Motivo do estorno é obrigatório' });

  await withTransaction(async (db) => {
    const { rows } = await db.query('SELECT * FROM parcelas WHERE id = $1 FOR UPDATE NOWAIT', [id]);
    if (!rows[0]) throw Object.assign(new Error('Parcela não encontrada'), { status: 404 });
    if (rows[0].valor_pago_cts === null)
      throw Object.assign(new Error('Parcela não tem baixa registrada'), { status: 409 });

    await db.query(
      `UPDATE parcelas SET estornado_em=NOW(), estornado_por=$1, motivo_estorno=$2,
         valor_pago_cts=NULL, data_pagamento=NULL, forma_pagamento=NULL,
         referencia_pag=NULL, tratamento_manual=false, tratamento_manual_motivo=NULL
       WHERE id=$3`, [user.sub, motivo, id]
    );
    await db.query(
      `INSERT INTO auditoria_exclusoes (tabela,registro_id,excluido_por,motivo) VALUES ('baixas',$1,$2,$3)`,
      [id, user.sub, `Estorno: ${motivo}`]
    );
  });
  return res.status(200).json({ ok: true, id });
}
