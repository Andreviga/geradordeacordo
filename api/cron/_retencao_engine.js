'use strict';
// api/cron/_retencao_engine.js — expurgo de dados pessoais (LGPD).
//
// O que faz: apaga o dado pessoal de devedores e alunos ligados apenas a acordos
// encerrados há mais de N anos. A LINHA CONTINUA existindo — acordos e parcelas
// dependem dela, e o registro financeiro precisa sobreviver. O que some é nome,
// CPF, RG, endereço, e-mail, telefone; a linha fica marcada com anonimizado_em.
//
// Encerrado = status 'quitado' ou 'cancelado' na view acordos_com_status.
// A contagem do prazo começa no último fato do acordo: o último pagamento, ou na
// falta dele o último vencimento, ou na falta dos dois a última atualização.
//
// Uma pessoa só é anonimizada quando TODOS os acordos dela estão encerrados e
// vencidos de prazo. Um único acordo recente ou em aberto preserva o cadastro
// inteiro — é o comportamento certo, e é o motivo de a consulta usar NOT EXISTS
// em vez de filtrar acordo a acordo.
//
// Prazo: RETENCAO_ANOS (padrão 5). O número vem da orientação usual de 5 anos
// após a quitação (prescrição do CDC), mas é decisão jurídica do colégio —
// confirme antes de agendar.
//
// Por segurança este motor NÃO está agendado no vercel.json. Rode o dry-run,
// confira a lista, e só então agende. Ver README.

const ANOS_PADRAO = 5;

const CAMPOS_DEVEDOR = [
  'rg', 'rg_emissor', 'nacionalidade', 'estado_civil', 'profissao',
  'end_logradouro', 'end_cep', 'end_cidade', 'email', 'telefone',
];

function anosDeRetencao() {
  const n = parseInt(process.env.RETENCAO_ANOS, 10);
  return Number.isInteger(n) && n > 0 ? n : ANOS_PADRAO;
}

// Data do último fato de cada acordo, para contar o prazo a partir dela
const SQL_FIM_DO_ACORDO = `
  SELECT a.id,
         acs.status,
         COALESCE(
           (SELECT MAX(p.data_pagamento) FROM parcelas p WHERE p.acordo_id = a.id),
           (SELECT MAX(p.vencimento)     FROM parcelas p WHERE p.acordo_id = a.id),
           a.atualizado_em::date,
           a.criado_em::date
         ) AS fim
  FROM acordos a JOIN acordos_com_status acs ON acs.id = a.id`;

/**
 * @param {object} pool  pool do pg (ou qualquer coisa com .query)
 * @param {{dryRun?: boolean, anos?: number}} opcoes
 */
async function executarRetencao(pool, { dryRun = true, anos = anosDeRetencao() } = {}) {
  const corte = new Date();
  corte.setFullYear(corte.getFullYear() - anos);
  const corteISO = corte.toISOString().slice(0, 10);

  // ── Quem está vencido de prazo ───────────────────────────────────────────
  // NOT EXISTS: basta um acordo em aberto, ou encerrado há pouco, para preservar
  const { rows: devedores } = await pool.query(
    `WITH fim AS (${SQL_FIM_DO_ACORDO})
     SELECT d.id, d.nome, d.cpf
     FROM devedores d
     WHERE d.anonimizado_em IS NULL
       AND EXISTS (SELECT 1 FROM acordo_devedores ad WHERE ad.devedor_id = d.id)
       AND NOT EXISTS (
         SELECT 1 FROM acordo_devedores ad JOIN fim ON fim.id = ad.acordo_id
         WHERE ad.devedor_id = d.id
           AND (fim.status NOT IN ('quitado','cancelado') OR fim.fim > $1::date)
       )
     ORDER BY d.nome`, [corteISO]
  );

  const { rows: alunos } = await pool.query(
    `WITH fim AS (${SQL_FIM_DO_ACORDO})
     SELECT al.id, al.nome
     FROM alunos al
     WHERE al.anonimizado_em IS NULL
       AND EXISTS (SELECT 1 FROM acordo_alunos aa WHERE aa.aluno_id = al.id)
       AND NOT EXISTS (
         SELECT 1 FROM acordo_alunos aa JOIN fim ON fim.id = aa.acordo_id
         WHERE aa.aluno_id = al.id
           AND (fim.status NOT IN ('quitado','cancelado') OR fim.fim > $1::date)
       )
     ORDER BY al.nome`, [corteISO]
  );

  // O snapshot da assinatura é uma cópia do documento, com as partes qualificadas
  const { rows: snapshots } = await pool.query(
    `WITH fim AS (${SQL_FIM_DO_ACORDO})
     SELECT a.id, a.numero FROM acordos a JOIN fim ON fim.id = a.id
     WHERE a.snapshot_assinatura_json IS NOT NULL
       AND fim.status IN ('quitado','cancelado')
       AND fim.fim <= $1::date`, [corteISO]
  );

  const relatorio = {
    dryRun, anos, corte: corteISO,
    devedores: devedores.length,
    alunos: alunos.length,
    snapshots: snapshots.length,
    amostra: {
      devedores: devedores.slice(0, 10).map(d => ({ nome: d.nome, cpf: mascararCpf(d.cpf) })),
      alunos:    alunos.slice(0, 10).map(a => a.nome),
      acordos:   snapshots.slice(0, 10).map(a => a.numero),
    },
  };

  if (dryRun || (!devedores.length && !alunos.length && !snapshots.length)) {
    relatorio.aplicado = false;
    return relatorio;
  }

  // ── Aplicar ──────────────────────────────────────────────────────────────
  const idsDev = devedores.map(d => d.id);
  const idsAlu = alunos.map(a => a.id);
  const idsAco = snapshots.map(a => a.id);

  if (idsDev.length) {
    // O CPF é UNIQUE, então não dá para zerar: vira um marcador único e sem
    // significado, derivado do próprio id.
    await pool.query(
      `UPDATE devedores SET
         nome = '(dados removidos por retencao)',
         cpf  = 'ANON-' || id::text,
         ${CAMPOS_DEVEDOR.map(c => `${c} = NULL`).join(', ')},
         anonimizado_em = NOW()
       WHERE id = ANY($1::uuid[])`, [idsDev]);
  }
  if (idsAlu.length) {
    await pool.query(
      `UPDATE alunos SET nome = '(dados removidos por retencao)',
         ra = NULL, serie = NULL, turno = NULL, anonimizado_em = NOW()
       WHERE id = ANY($1::uuid[])`, [idsAlu]);
  }
  if (idsAco.length) {
    await pool.query(
      `UPDATE acordos SET snapshot_assinatura_json = NULL WHERE id = ANY($1::uuid[])`, [idsAco]);
  }

  // Rastro do que foi feito — sem repetir o dado pessoal que acabou de sair
  for (const id of idsDev)
    await pool.query(
      `INSERT INTO auditoria_exclusoes (tabela, registro_id, excluido_por, motivo)
       VALUES ('devedores', $1, NULL, $2)`,
      [id, `Retencao LGPD: encerrado ha mais de ${anos} anos (corte ${corteISO})`]);
  for (const id of idsAlu)
    await pool.query(
      `INSERT INTO auditoria_exclusoes (tabela, registro_id, excluido_por, motivo)
       VALUES ('alunos', $1, NULL, $2)`,
      [id, `Retencao LGPD: encerrado ha mais de ${anos} anos (corte ${corteISO})`]);

  relatorio.aplicado = true;
  return relatorio;
}

function mascararCpf(cpf) {
  const n = String(cpf || '').replace(/\D/g, '');
  return n.length === 11 ? `***.${n.slice(3, 6)}.${n.slice(6, 9)}-**` : '(sem cpf)';
}

module.exports = { executarRetencao, anosDeRetencao, mascararCpf, ANOS_PADRAO };
