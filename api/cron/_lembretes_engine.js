'use strict';
// api/cron/_lembretes_engine.js — lógica central de lembretes.
// Chamada pelo handler HTTP (api/cron/index.js) e pelo script CLI (scripts/cron-lembretes.js).

const { getPool }            = require('../_db');
const { calcularEvento }     = require('./_calcularEvento');

const CONTATO_EMAIL = process.env.CONTATO_SECRETARIA_EMAIL || 'contato@raizesedu.com.br';
const CONTATO_FONE  = process.env.CONTATO_SECRETARIA_FONE  || '(11) 2741-9849';
const APP_URL       = (process.env.APP_URL || 'https://gerador-acordo.vercel.app').replace(/\/$/, '');
const MAX_ENVIOS    = parseInt(process.env.LEMBRETES_MAX_POR_EXECUCAO || '5', 10);

// ─── Consultas de candidatos ──────────────────────────────────────────────────

// Parcelas candidatas COM e-mail de devedor (D-3, D+1, D+7 enviam ao devedor).
async function buscarCandidatosComEmail(pool) {
  const { rows } = await pool.query(`
    SELECT
      p.id                              AS parcela_id,
      p.numero                          AS parcela_numero,
      p.vencimento::date::text          AS vencimento,
      p.valor_previsto_cts,
      p.tratamento_manual,
      (p.vencimento::date - CURRENT_DATE) AS dias,
      a.id                              AS acordo_id,
      a.numero                          AS acordo_numero,
      a.multa_mora_pct,
      a.juros_pct,
      d.id                              AS devedor_id,
      d.nome                            AS devedor_nome,
      d.email                           AS devedor_email
    FROM parcelas p
    JOIN acordos a ON a.id = p.acordo_id
    JOIN acordo_devedores ad ON ad.acordo_id = a.id AND ad.papel = 'devedor'
    JOIN devedores d ON d.id = ad.devedor_id
    WHERE a.lembretes_ativos = true
      AND a.cancelado = false
      AND p.valor_pago_cts IS NULL
      AND p.renegociada = false
      AND p.vencimento IS NOT NULL
      AND d.email IS NOT NULL AND d.email != ''
    ORDER BY p.vencimento
  `);
  return rows;
}

// Parcelas que atingiram D+15 — sem filtro de e-mail.
// D+15 não envia ao devedor: marca tratamento_manual e notifica a secretaria.
// Filtrar por e-mail aqui significaria nunca sinalizar devedores sem contato, que são
// exatamente os que mais precisam de intervenção humana.
async function buscarCandidatosD15(pool) {
  const { rows } = await pool.query(`
    SELECT
      p.id                              AS parcela_id,
      p.numero                          AS parcela_numero,
      p.vencimento::date::text          AS vencimento,
      p.valor_previsto_cts,
      p.tratamento_manual,
      (p.vencimento::date - CURRENT_DATE) AS dias,
      a.id                              AS acordo_id,
      a.numero                          AS acordo_numero,
      a.multa_mora_pct,
      a.juros_pct,
      d.id                              AS devedor_id,
      d.nome                            AS devedor_nome,
      d.email                           AS devedor_email
    FROM parcelas p
    JOIN acordos a ON a.id = p.acordo_id
    JOIN acordo_devedores ad ON ad.acordo_id = a.id AND ad.papel = 'devedor'
    JOIN devedores d ON d.id = ad.devedor_id
    WHERE a.lembretes_ativos = true
      AND a.cancelado = false
      AND p.valor_pago_cts IS NULL
      AND p.renegociada = false
      AND p.vencimento IS NOT NULL
      AND (p.vencimento::date - CURRENT_DATE) <= -15
    ORDER BY p.vencimento
  `);
  return rows;
}

// Resumo para o dry-run: total de parcelas vencidas e motivos de exclusão.
async function buscarResumoExclusoes(pool) {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)                                                FILTER (WHERE p.valor_pago_cts IS NULL AND p.renegociada = false) AS total_pendentes,
      COUNT(*)                                                FILTER (WHERE a.lembretes_ativos = false AND p.valor_pago_cts IS NULL AND p.renegociada = false) AS excl_sem_lembrete,
      COUNT(*)                                                FILTER (WHERE a.cancelado = true  AND p.valor_pago_cts IS NULL AND p.renegociada = false) AS excl_cancelado,
      COUNT(*)                                                FILTER (WHERE (d.email IS NULL OR d.email = '') AND a.lembretes_ativos = true AND a.cancelado = false AND p.valor_pago_cts IS NULL AND p.renegociada = false AND (p.vencimento::date - CURRENT_DATE) BETWEEN -14 AND -1) AS excl_sem_email_d1d7,
      COUNT(*)                                                FILTER (WHERE p.tratamento_manual = true AND a.lembretes_ativos = true AND a.cancelado = false AND p.valor_pago_cts IS NULL AND p.renegociada = false) AS ja_em_tratamento_manual,
      COUNT(*)                                                FILTER (WHERE (p.vencimento::date - CURRENT_DATE) > 3 AND a.lembretes_ativos = true AND a.cancelado = false AND p.valor_pago_cts IS NULL AND p.renegociada = false) AS muito_cedo
    FROM parcelas p
    JOIN acordos a ON a.id = p.acordo_id
    JOIN acordo_devedores ad ON ad.acordo_id = a.id AND ad.papel = 'devedor'
    JOIN devedores d ON d.id = ad.devedor_id
    WHERE p.vencimento IS NOT NULL
  `);
  return rows[0];
}

// ─── Formata valor em reais ───────────────────────────────────────────────────
function fmt(cts) {
  return 'R$ ' + (parseInt(cts, 10) / 100).toFixed(2).replace('.', ',');
}

// ─── HTML de cada template ────────────────────────────────────────────────────
function htmlDevedor(titulo, corpo, isTest) {
  const prefixo = isTest ? '<p style="background:#ffe066;padding:8px;border-radius:4px"><strong>[ENVIO DE VALIDAÇÃO]</strong> Este é um e-mail de teste — nenhuma ação é necessária.</p>' : '';
  return `<!DOCTYPE html><html lang="pt-BR"><body style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#222">
${prefixo}
<p>${corpo.replace(/\n/g, '</p><p>')}</p>
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="font-size:12px;color:#888">Colégio Raízes | ${CONTATO_EMAIL} | ${CONTATO_FONE}</p>
</body></html>`;
}

function htmlInterno(r, isTest) {
  const prefixo = isTest ? '<p style="background:#ffe066;padding:8px;border-radius:4px"><strong>[ENVIO DE VALIDAÇÃO]</strong> Este é um e-mail de teste — nenhuma ação é necessária.</p>' : '';
  return `<!DOCTYPE html><html lang="pt-BR"><body style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#222">
${prefixo}
<h3 style="color:#a00">Ação necessária — Acordo nº ${r.acordo_numero}</h3>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:6px 12px 6px 0;color:#555">Devedor</td><td><strong>${r.devedor_nome}</strong></td></tr>
<tr><td style="padding:6px 12px 6px 0;color:#555">Parcela</td><td>${r.parcela_numero}ª — vencimento ${r.vencimento}</td></tr>
<tr><td style="padding:6px 12px 6px 0;color:#555">Valor previsto</td><td>${fmt(r.valor_previsto_cts)}</td></tr>
<tr><td style="padding:6px 12px 6px 0;color:#555">Dias em atraso</td><td>${Math.abs(r.dias)}</td></tr>
<tr><td style="padding:6px 12px 6px 0;color:#555">Encargos</td><td>Multa ${r.multa_mora_pct || 0}% + Juros ${r.juros_pct || 0}% a.m.</td></tr>
</table>
<p>O sistema não enviará mais lembretes automáticos para este devedor.<br>Um operador deve assumir o contato direto.</p>
<p><a href="${APP_URL}">Abrir o sistema</a> e pesquisar pelo acordo nº <strong>${r.acordo_numero}</strong>.</p>
</body></html>`;
}

// ─── Textos das mensagens ─────────────────────────────────────────────────────
function assuntoDevedor(numero, isTest) {
  const base = `Colégio Raízes — comunicado sobre o acordo nº ${numero}`;
  return isTest ? `[TESTE] ${base}` : base;
}

function textoD3(r)  {
  return `Olá, ${r.devedor_nome}.\n\nGostaríamos de lembrar que há um compromisso referente ao acordo nº ${r.acordo_numero} com vencimento nos próximos dias.\n\nSe precisar de qualquer informação, entre em contato com a secretaria:\n${CONTATO_EMAIL} | ${CONTATO_FONE}\n\nColégio Raízes`;
}
function textoD1(r)  {
  return `Olá, ${r.devedor_nome}.\n\nNotamos que o compromisso referente ao acordo nº ${r.acordo_numero} ainda não foi regularizado.\n\nSe já efetuou o pagamento, desconsidere este aviso — às vezes há um pequeno intervalo até o sistema ser atualizado.\n\nCaso precise conversar sobre isso, estamos à disposição:\n${CONTATO_EMAIL} | ${CONTATO_FONE}\n\nColégio Raízes`;
}
function textoD7(r)  {
  return `Olá, ${r.devedor_nome}.\n\nAinda não identificamos o pagamento referente ao acordo nº ${r.acordo_numero}.\n\nConforme previsto no acordo, há encargos por atraso a partir do vencimento — a secretaria pode informar o valor atualizado.\n\nSabemos que imprevistos acontecem. Entre em contato para combinarmos a melhor forma de seguir em frente:\n${CONTATO_EMAIL} | ${CONTATO_FONE}\n\nColégio Raízes`;
}

function assuntoInterno(numero, isTest) {
  const base = `[Ação necessária] Acordo nº ${numero} — 15 dias em atraso`;
  return isTest ? `[TESTE] ${base}` : base;
}

// ─── Dados sintéticos para --test-email (zero consultas ao banco) ─────────────
const MODELO_TESTE = {
  acordo_numero:      'TESTE-001',
  parcela_numero:     '3',
  vencimento:         new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
  valor_previsto_cts: 85000,
  multa_mora_pct:     2,
  juros_pct:          1,
  devedor_nome:       'Maria Silva (devedor de exemplo)',
  devedor_email:      CONTATO_EMAIL,
  dias:               -7,
  parcela_id:         '00000000-0000-0000-0000-000000000000',
};

async function enviarEmailsTeste() {
  const adapter = require('./_emailAdapter');
  const enviados = [], erros = [];
  const templates = [
    { evento: 'D-3', texto: textoD3(MODELO_TESTE), fn: textoD3 },
    { evento: 'D+1', texto: textoD1(MODELO_TESTE), fn: textoD1 },
    { evento: 'D+7', texto: textoD7(MODELO_TESTE), fn: textoD7 },
  ];
  for (const t of templates) {
    const assunto = assuntoDevedor(MODELO_TESTE.acordo_numero, true);
    const corpo   = t.fn(MODELO_TESTE);
    try {
      await adapter.send({ to: CONTATO_EMAIL, subject: assunto, text: corpo,
        html: htmlDevedor(assunto, corpo, true), replyTo: CONTATO_EMAIL });
      enviados.push(t.evento);
    } catch (err) { erros.push({ evento: t.evento, erro: err.message }); }
  }
  // Template interno D+15
  try {
    const assunto = assuntoInterno(MODELO_TESTE.acordo_numero, true);
    await adapter.send({ to: CONTATO_EMAIL, subject: assunto,
      html: htmlInterno(MODELO_TESTE, true), replyTo: CONTATO_EMAIL,
      text: `[ENVIO DE VALIDAÇÃO]\n\nAcordo ${MODELO_TESTE.acordo_numero} | Devedor: ${MODELO_TESTE.devedor_nome}\nValor: ${fmt(MODELO_TESTE.valor_previsto_cts)} | Atraso: ${Math.abs(MODELO_TESTE.dias)} dias` });
    enviados.push('D+15-interno');
  } catch (err) { erros.push({ evento: 'D+15-interno', erro: err.message }); }
  return { enviados, erros };
}

// ─── Executor principal ───────────────────────────────────────────────────────
async function executarLembretes({ dryRun = false, testEmail = false } = {}) {
  // --test-email: zero consultas ao banco, zero gravações — dados 100% sintéticos
  if (testEmail) return enviarEmailsTeste();

  const pool = getPool();
  if (!pool) throw new Error('DATABASE_URL não configurado');

  const [comEmail, d15rows] = await Promise.all([
    buscarCandidatosComEmail(pool),
    buscarCandidatosD15(pool),
  ]);

  // Calcular eventos para os candidatos com e-mail (D-3, D+1, D+7)
  const paraDevedor = [];
  for (const r of comEmail) {
    const evento = calcularEvento(Number(r.dias));
    if (evento && evento !== 'D+15') paraDevedor.push({ ...r, evento });
  }

  // D+15: não usa filtro de e-mail; já filtrado na query
  const paraD15 = d15rows;

  if (dryRun) {
    const resumo = await buscarResumoExclusoes(pool);
    return {
      dryRun: true,
      resumo: {
        total_pendentes:         Number(resumo.total_pendentes),
        excl_sem_lembrete:       Number(resumo.excl_sem_lembrete),
        excl_cancelado:          Number(resumo.excl_cancelado),
        excl_sem_email_d1_d7:    Number(resumo.excl_sem_email_d1d7),
        ja_em_tratamento_manual: Number(resumo.ja_em_tratamento_manual),
        muito_cedo:              Number(resumo.muito_cedo),
      },
      cap: MAX_ENVIOS,
      paraDevedor: paraDevedor.map(e => ({
        evento:  e.evento,
        acordo:  e.acordo_numero,
        devedor: e.devedor_nome,
        email:   e.devedor_email,
        dias:    Number(e.dias),
      })),
      paraD15: paraD15.map(e => ({
        acordo:              e.acordo_numero,
        devedor:             e.devedor_nome,
        email:               e.devedor_email || '(sem e-mail)',
        dias_atraso:         Math.abs(Number(e.dias)),
        tratamento_manual:   e.tratamento_manual,
      })),
    };
  }

  // Verificar cap de segurança (conta apenas e-mails ao devedor, não avisos internos)
  if (!testEmail && paraDevedor.length > MAX_ENVIOS) {
    throw new Error(
      `LEMBRETES_MAX_POR_EXECUCAO (${MAX_ENVIOS}) excedido: ${paraDevedor.length} e-mails para devedores pendentes. ` +
      'Verifique o dry-run e ajuste o limite antes de prosseguir.'
    );
  }

  const adapter = require('./_emailAdapter');
  let enviados = 0;
  const erros  = [];

  // ── Lembretes ao devedor (D-3, D+1, D+7) ────────────────────────────────
  for (const r of paraDevedor) {
    const texto        = r.evento === 'D-3' ? textoD3(r) : r.evento === 'D+1' ? textoD1(r) : textoD7(r);
    const destinatario = r.devedor_email;

    let rowId = null;
    {
      // Verificar se já enviado
      const jaEnviado = await pool.query(
        `SELECT 1 FROM lembretes_enviados WHERE parcela_id=$1 AND evento=$2 AND devedor_id=$3 AND status='ok'`,
        [r.parcela_id, r.evento, r.devedor_id]
      );
      if (jaEnviado.rows.length > 0) continue;
    }
    {
      const ins = await pool.query(
        `INSERT INTO lembretes_enviados (parcela_id, devedor_id, evento, canal, destinatario, tentativas, status)
         VALUES ($1,$2,$3,'email',$4,1,'pendente')
         ON CONFLICT ON CONSTRAINT lembretes_unique DO UPDATE SET tentativas = lembretes_enviados.tentativas + 1
         RETURNING id`,
        [r.parcela_id, r.devedor_id, r.evento, destinatario]
      );
      rowId = ins.rows[0]?.id;
    }

    try {
      await adapter.send({
        to:      destinatario,
        subject: assuntoDevedor(r.acordo_numero, false),
        text:    texto,
        html:    htmlDevedor(assuntoDevedor(r.acordo_numero, false), texto, false),
        replyTo: CONTATO_EMAIL,
      });
      if (rowId) await pool.query(`UPDATE lembretes_enviados SET status='ok', enviado_em=NOW() WHERE id=$1`, [rowId]);
      enviados++;
    } catch (err) {
      if (rowId) await pool.query(`UPDATE lembretes_enviados SET status='falha', erro_msg=$2 WHERE id=$1`, [rowId, err.message]);
      erros.push({ evento: r.evento, acordo: r.acordo_numero, devedor: r.devedor_nome, erro: err.message });
    }
  }

  // ── D+15: marcar tratamento_manual + aviso interno ────────────────────────
  for (const r of paraD15) {
    // Verificar se aviso interno já foi enviado (índice único por parcela+canal)
    const jaInterno = await pool.query(
      `SELECT 1 FROM lembretes_enviados WHERE parcela_id=$1 AND canal='interno_d15' AND status='ok'`,
      [r.parcela_id]
    );
    if (jaInterno.rows.length > 0) continue;

    // Marcar tratamento_manual
    await pool.query(
      `UPDATE parcelas SET tratamento_manual=true, tratamento_manual_motivo='D+15: sem pagamento há 15 dias' WHERE id=$1`,
      [r.parcela_id]
    );

    // Registrar aviso interno
    const ins = await pool.query(
      `INSERT INTO lembretes_enviados (parcela_id, devedor_id, evento, canal, destinatario, tentativas, status)
       VALUES ($1, NULL, 'D+15', 'interno_d15', $2, 1, 'pendente')
       ON CONFLICT (parcela_id, canal) WHERE canal='interno_d15' DO UPDATE SET tentativas = lembretes_enviados.tentativas + 1
       RETURNING id`,
      [r.parcela_id, CONTATO_EMAIL]
    );
    const rowId = ins.rows[0]?.id;

    try {
      await adapter.send({
        to:      CONTATO_EMAIL,
        subject: assuntoInterno(r.acordo_numero, false),
        text:    `Acordo nº ${r.acordo_numero} — 15 dias em atraso\nDevedor: ${r.devedor_nome}\nParcela: ${r.parcela_numero}ª — ${r.vencimento}\nValor: ${fmt(r.valor_previsto_cts)}\nEncargos: multa ${r.multa_mora_pct || 0}% + juros ${r.juros_pct || 0}% a.m.\n\nAcesse ${APP_URL} e pesquise pelo acordo nº ${r.acordo_numero}.`,
        html:    htmlInterno(r, false),
        replyTo: CONTATO_EMAIL,
      });
      if (rowId) await pool.query(`UPDATE lembretes_enviados SET status='ok', enviado_em=NOW() WHERE id=$1`, [rowId]);
      enviados++;
    } catch (err) {
      if (rowId) await pool.query(`UPDATE lembretes_enviados SET status='falha', erro_msg=$2 WHERE id=$1`, [rowId, err.message]);
      erros.push({ evento: 'D+15-interno', acordo: r.acordo_numero, erro: err.message });
    }
  }

  return { enviados, erros, total: paraDevedor.length + paraD15.length };
}

module.exports = { executarLembretes };
