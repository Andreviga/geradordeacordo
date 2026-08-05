'use strict';
// api/parcelas/[id]/baixar.js  →  POST /api/parcelas/:id/baixar
//
// Overpayment: aceito (encargos por atraso são o caso comum).
//   - valor <= 2x previsto: aceita com aviso na UI, classification opcional
//   - valor >  2x previsto: exige confirmarValorExcessivo:true no body
// Partial payment: marca tratamento_manual=true para fila humana.
// Replacing partial with full payment: clears tratamento_manual automatically.

const { verificarRequisicaoComBanco, applyCors } = require('../../../api/_auth');
const { withTransaction, isDbUnavailable }        = require('../../../api/_db');

const FORMAS_VALIDAS = ['pix','ted','boleto','especie','cartao','cheque','outro'];
const CLASSIF_VALIDAS = ['encargos_atraso','adiantamento_parcela','erro_verificar'];

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

  const b = req.body || {};

  // Garantir integer; parseInt(null,10) = NaN → rejeitado a seguir
  const valorPagoCts = Number.isInteger(b.valorPagoCts)
    ? b.valorPagoCts
    : (b.valorPagoCts != null ? parseInt(b.valorPagoCts, 10) : NaN);
  if (!Number.isInteger(valorPagoCts) || valorPagoCts <= 0)
    return res.status(400).json({ erro: 'valorPagoCts deve ser inteiro positivo (em centavos)' });

  if (!b.dataPagamento || !/^\d{4}-\d{2}-\d{2}$/.test(b.dataPagamento))
    return res.status(400).json({ erro: 'dataPagamento obrigatório no formato AAAA-MM-DD' });
  const hoje = new Date().toISOString().slice(0, 10);
  if (b.dataPagamento > hoje)
    return res.status(400).json({ erro: 'Data de pagamento não pode ser futura' });

  if (b.formaPagamento && !FORMAS_VALIDAS.includes(b.formaPagamento))
    return res.status(400).json({ erro: `formaPagamento inválida. Aceito: ${FORMAS_VALIDAS.join(', ')}` });
  if (b.classificacaoExcedente && !CLASSIF_VALIDAS.includes(b.classificacaoExcedente))
    return res.status(400).json({ erro: `classificacaoExcedente inválida. Aceito: ${CLASSIF_VALIDAS.join(', ')}` });

  try {
    const resultado = await withTransaction(async (db) => {
      const { rows } = await db.query(
        `SELECT p.*, a.cancelado, a.assinado_em, a.criado_em, a.data_assinatura
         FROM parcelas p JOIN acordos a ON a.id = p.acordo_id
         WHERE p.id = $1 FOR UPDATE NOWAIT`,
        [id]
      );
      if (!rows[0]) throw Object.assign(new Error('Parcela não encontrada'), { status: 404 });
      const p = rows[0];
      if (p.cancelado)   throw Object.assign(new Error('Acordo cancelado'), { status: 409 });
      if (p.renegociada) throw Object.assign(new Error('Parcela renegociada não aceita baixa'), { status: 409 });

      // Limite retroativo: data_assinatura (juridicamente relevante) ou criado_em como fallback
      const dtRef = p.data_assinatura
        ? (p.data_assinatura instanceof Date
            ? p.data_assinatura.toISOString().slice(0, 10)
            : String(p.data_assinatura))
        : (p.criado_em instanceof Date
            ? p.criado_em.toISOString().slice(0, 10)
            : String(p.criado_em).slice(0, 10));
      if (b.dataPagamento < dtRef)
        throw Object.assign(
          new Error(`Data de pagamento (${b.dataPagamento}) anterior à data do acordo (${dtRef}).`),
          { status: 400, code: 'DATA_ANTERIOR_ACORDO' }
        );

      const previstoCts = Number(p.valor_previsto_cts); // pg BIGINT → string; converter
      const excedente   = Math.max(0, valorPagoCts - previstoCts);

      // Bloquear apenas valores suspeitos (> 2x previsto) sem confirmação explícita
      if (valorPagoCts > 2 * previstoCts && !b.confirmarValorExcessivo)
        throw Object.assign(
          new Error(`Valor (${valorPagoCts} cts) excede o dobro do previsto (${previstoCts} cts). Envie confirmarValorExcessivo:true se correto.`),
          { status: 400, code: 'VALOR_SUSPEITO' }
        );

      // Sobrescrever pagamento existente exige confirmação
      if (p.valor_pago_cts !== null && !b.confirmarSobrescrita)
        throw Object.assign(
          new Error('Esta parcela já tem pagamento registrado. Envie confirmarSobrescrita:true para substituir.'),
          { status: 409, code: 'PARCELA_JA_PAGA' }
        );

      // tratamento_manual:
      //   pagamento completo → sempre limpa (qualquer que seja o motivo original)
      //   pagamento parcial  → mantém motivo existente se for mais crítico que 'pagamento parcial'
      //   (limite_cadencia_D15 + pagamento integral = problema resolvido → limpar é correto)
      const parcial = valorPagoCts < previstoCts;
      const tmMotivoAtual = p.tratamento_manual_motivo;
      const novoTmMotivo  = !parcial
        ? null
        : (tmMotivoAtual && tmMotivoAtual !== 'pagamento parcial' ? tmMotivoAtual : 'pagamento parcial');

      await db.query(
        `UPDATE parcelas SET
           valor_pago_cts           = $1,
           data_pagamento           = $2,
           forma_pagamento          = $3,
           referencia_pag           = $4,
           observacao               = $5,
           registrado_por           = $6,
           tratamento_manual        = $7,
           tratamento_manual_motivo = $8,
           classificacao_excedente  = $9,
           estornado_em  = NULL, estornado_por = NULL, motivo_estorno = NULL
         WHERE id = $10`,
        [valorPagoCts, b.dataPagamento, b.formaPagamento || null,
         b.referencia || null, b.observacao || null, user.sub,
         parcial, novoTmMotivo,
         excedente > 0 ? (b.classificacaoExcedente || null) : null,
         id]
      );

      return {
        id,
        saldoCts:           Math.max(0, previstoCts - valorPagoCts),
        valorExcedenteCts:  excedente,
        parcial,
      };
    });

    return res.status(200).json({ ok: true, ...resultado });
  } catch (err) {
    if (err.code === '55P03') return res.status(409).json({ erro: 'Parcela em uso. Tente novamente.', code: 'LOCK_NAO_DISPONIVEL' });
    if (err.status) return res.status(err.status).json({ erro: err.message, code: err.code });
    if (isDbUnavailable(err)) return res.status(503).json({ erro: 'Banco indisponível' });
    console.error('[parcelas/baixar]', err.message);
    return res.status(500).json({ erro: 'Erro interno' });
  }
};
