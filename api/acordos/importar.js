'use strict';
// api/acordos/importar.js  →  POST /api/acordos/importar
//
// Cadastro retroativo: acordo existente em papel, registrado no sistema agora.
// lembretes_ativos = false por padrão — secretaria ativa conscientemente após verificar.
// Parcelas pagas informadas no payload; sem necessidade de N requests individuais.
// Número próprio respeitado; se não informado, gera da sequência pelo ano da data_assinatura.

const { verificarRequisicaoComBanco, applyCors } = require('../_auth');
const { withTransaction, isDbUnavailable }        = require('../_db');

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ erro: 'Método não permitido' });

  const user = await verificarRequisicaoComBanco(req, res);
  if (!user) return;

  const b = req.body || {};

  if (!Array.isArray(b.devedores) || !b.devedores.length)
    return res.status(400).json({ erro: 'Pelo menos um devedor é obrigatório' });
  if (!b.acordo?.valorTotalCts || b.acordo.valorTotalCts <= 0)
    return res.status(400).json({ erro: 'valorTotalCts obrigatório e positivo' });
  if (!Array.isArray(b.parcelas) || !b.parcelas.length)
    return res.status(400).json({ erro: 'Pelo menos uma parcela é obrigatória' });

  try {
    const resultado = await withTransaction(async (db) => {

      // 1. Devedores (mesma regra de CPF do salvar)
      const devedoresSalvos = [];
      const divergencias    = [];
      const atualizarCPFs   = new Set(b.atualizarDevedores || []);
      const manterCPFs      = new Set(b.manterDevedores    || []);

      for (const d of b.devedores) {
        if (!d.cpf) throw Object.assign(new Error('CPF obrigatório para cada devedor'), { status: 400 });
        const { rows: ex } = await db.query('SELECT * FROM devedores WHERE cpf = $1', [d.cpf]);

        if (ex.length > 0) {
          const atual = ex[0];
          const diff  = camposDivergentes(atual, d);
          if (diff.length > 0 && !atualizarCPFs.has(d.cpf) && !manterCPFs.has(d.cpf)) {
            divergencias.push({ cpf: d.cpf, diff });
            continue;
          }
          if (diff.length > 0 && atualizarCPFs.has(d.cpf)) {
            await db.query(
              `UPDATE devedores SET nome=$1,rg=$2,rg_emissor=$3,nacionalidade=$4,
               estado_civil=$5,profissao=$6,end_logradouro=$7,end_cep=$8,
               end_cidade=$9,email=$10,telefone=$11,atualizado_em=NOW() WHERE id=$12`,
              [d.nome,d.rg||null,d.rgEmissor||null,d.nac||null,
               d.civil||null,d.prof||null,d.end||null,d.cep||null,
               d.cid||null,d.email||null,d.tel||null,atual.id]
            );
          }
          devedoresSalvos.push({ id: atual.id, papel: d.papel||'devedor', ordem: d.ordem||1 });
        } else {
          const { rows: novo } = await db.query(
            `INSERT INTO devedores (nome,cpf,rg,rg_emissor,nacionalidade,estado_civil,profissao,
             end_logradouro,end_cep,end_cidade,email,telefone)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [d.nome,d.cpf,d.rg||null,d.rgEmissor||null,d.nac||null,
             d.civil||null,d.prof||null,d.end||null,d.cep||null,
             d.cid||null,d.email||null,d.tel||null]
          );
          devedoresSalvos.push({ id: novo[0].id, papel: d.papel||'devedor', ordem: d.ordem||1 });
        }
      }
      if (divergencias.length > 0)
        throw Object.assign(new Error('CPF_DIVERGENCIA'), { divergencias });

      // 2. Número do acordo
      const a = b.acordo;
      let numero = a.numero?.trim() || null;

      if (numero) {
        // Número próprio: verificar colisão sem tocar na sequência
        const { rows: dup } = await db.query('SELECT id FROM acordos WHERE numero = $1', [numero]);
        if (dup.length > 0)
          throw Object.assign(
            new Error(`Número "${numero}" já existe. Altere ou omita para gerar automaticamente.`),
            { status: 409, code: 'NUMERO_DUPLICADO' }
          );
      } else {
        // Usar o ano da data de assinatura; não polui a sequência de outro ano
        const anoRef = a.dataAssinatura
          ? parseInt(a.dataAssinatura.slice(0, 4), 10)
          : new Date().getFullYear();
        const { rows: numR } = await db.query(
          `INSERT INTO acordo_numero_seq (ano, ultimo) VALUES ($1, 1)
           ON CONFLICT (ano) DO UPDATE SET ultimo = acordo_numero_seq.ultimo + 1
           RETURNING ano, ultimo`,
          [anoRef]
        );
        numero = `${numR[0].ano}/${String(numR[0].ultimo).padStart(3, '0')}`;
      }

      // 3. Acordo retroativo
      const { rows: acR } = await db.query(
        `INSERT INTO acordos (
           numero, valor_total_cts, entrada_cts, n_parcelas, valor_parcela_cts,
           data_primeira_parcela, multa_mora_pct, juros_pct, multa_penal_pct,
           honorarios_pct, indice_correcao, origem_divida, periodo_referencia,
           foro, modo_assinatura, criado_por, data_assinatura,
           lembretes_ativos, lembretes_desativado_por,
           snapshot_assinatura_json
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,false,$18,null)
         RETURNING id, atualizado_em`,
        [numero, a.valorTotalCts, a.entradaCts||0, a.nParcelas||null, a.valorParcelaCts||null,
         a.dataPrimeiraParcela||null, a.multaMoraPct||null, a.jurosPct||null, a.multaPenalPct||null,
         a.honorariosPct||null, a.indiceCorrecao||null, a.origemDivida||null,
         a.periodoReferencia||null, a.foro||null, 'fisico', user.sub,
         a.dataAssinatura||null, 'importacao_retroativa']
      );
      const acordoId = acR[0].id;

      // 4. Junções
      for (const d of devedoresSalvos)
        await db.query(
          'INSERT INTO acordo_devedores (acordo_id,devedor_id,papel,ordem) VALUES ($1,$2,$3,$4)',
          [acordoId, d.id, d.papel, d.ordem]
        );
      for (const c of (b.credoras || [])) {
        let credoraId;
        if (c.cnpj) {
          const { rows: ex } = await db.query('SELECT id FROM credoras WHERE cnpj=$1', [c.cnpj]);
          if (ex.length > 0) credoraId = ex[0].id;
        }
        if (!credoraId) {
          const { rows: novo } = await db.query(
            `INSERT INTO credoras (nome,cnpj,tipo,end_logradouro,end_cidade,end_uf)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [c.nome,c.cnpj||null,c.tipo||'pj',c.end||null,c.cid||null,c.uf||null]
          );
          credoraId = novo[0].id;
        }
        await db.query(
          'INSERT INTO acordo_credoras (acordo_id,credora_id,valor_cts,representante,cargo) VALUES ($1,$2,$3,$4,$5)',
          [acordoId,credoraId,c.valorCts||null,c.rep||null,c.cargo||null]
        );
      }
      for (const al of (b.alunos || [])) {
        const { rows: novo } = await db.query(
          'INSERT INTO alunos (nome,serie,turno,ra) VALUES ($1,$2,$3,$4) RETURNING id',
          [al.nome,al.serie||null,al.turno||null,al.ra||null]
        );
        await db.query('INSERT INTO acordo_alunos (acordo_id,aluno_id) VALUES ($1,$2)', [acordoId,novo[0].id]);
      }

      // 5. Parcelas em lote, incluindo pagamentos já realizados
      for (const p of b.parcelas) {
        const previsto = Number(p.valorPrevistoCts);
        const pago     = p.valorPagoCts != null ? Number(p.valorPagoCts) : null;
        const parcial  = pago !== null && pago < previsto;
        await db.query(
          `INSERT INTO parcelas (
             acordo_id, numero, vencimento, valor_previsto_cts,
             valor_pago_cts, data_pagamento, forma_pagamento,
             referencia_pag, observacao, registrado_por,
             renegociada, tratamento_manual, tratamento_manual_motivo,
             classificacao_excedente
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [acordoId, p.numero, p.vencimento, previsto,
           pago, p.dataPagamento||null, p.formaPagamento||null,
           p.referencia||null, p.observacao||null, pago != null ? user.sub : null,
           p.renegociada||false,
           parcial, parcial ? 'pagamento parcial' : null,
           p.classificacaoExcedente||null]
        );
      }

      return { id: acordoId, numero, atualizado_em: acR[0].atualizado_em, lembretesAtivos: false };
    });

    // Upload do PDF ao Drive se fornecido e Drive configurado
    if (b.pdfBase64 && process.env.GOOGLE_SERVICE_ACCOUNT_JSON && resultado.id) {
      try {
        const driveFileid = await uploadPdfToDrive(b.pdfBase64, `${resultado.numero}.pdf`);
        if (driveFileid) {
          const pool = require('../_db').getPool();
          await pool?.query('UPDATE acordos SET drive_file_id = $1 WHERE id = $2', [driveFileid, resultado.id]);
          resultado.drive_file_id = driveFileid;
        }
      } catch (e) {
        console.warn('[importar] PDF upload falhou (acordo salvo sem Drive):', e.message);
        resultado.drive_upload_aviso = 'PDF não salvo no Drive: ' + e.message;
      }
    }

    return res.status(201).json(resultado);
  } catch (err) {
    if (err.message === 'CPF_DIVERGENCIA')
      return res.status(409).json({ erro: 'CPF_DIVERGENCIA', divergencias: err.divergencias });
    if (err.code === 'NUMERO_DUPLICADO')
      return res.status(409).json({ erro: err.message, code: err.code });
    if (err.status === 400) return res.status(400).json({ erro: err.message });
    if (isDbUnavailable(err)) return res.status(503).json({ erro: 'Banco indisponível' });
    console.error('[importar]', err.message);
    return res.status(500).json({ erro: 'Erro interno' });
  }
};

const MAPA = { nome:'nome', rg:'rg', rgEmissor:'rg_emissor', email:'email',
               tel:'telefone', end:'end_logradouro', cid:'end_cidade' };
function camposDivergentes(db, form) {
  const diff = [];
  for (const [fKey, dbKey] of Object.entries(MAPA)) {
    const a = (db[dbKey]  || '').trim();
    const b = (form[fKey] || '').trim();
    if (a && b && a !== b) diff.push({ campo: dbKey, antigo: a, novo: b });
  }
  return diff;
}

// Upload de PDF base64 para o Google Drive — mesma lógica de auth de health.js
async function uploadPdfToDrive(base64, nome) {
  const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const folderId = process.env.DRIVE_PDF_FOLDER_ID;
  if (!saRaw || !folderId) return null;

  const text = saRaw.startsWith('{') ? saRaw : Buffer.from(saRaw, 'base64').toString('utf8');
  const sa   = JSON.parse(text);
  const crypto = require('crypto');
  const now    = Math.floor(Date.now() / 1000);
  const hdr    = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const pay    = Buffer.from(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })).toString('base64url');
  const sig = crypto.createSign('RSA-SHA256').update(`${hdr}.${pay}`).sign(sa.private_key, 'base64url');
  const tokR = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${hdr}.${pay}.${sig}` }),
  });
  const { access_token } = await tokR.json();

  const pdfBytes = Buffer.from(base64, 'base64');
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name: nome, parents: [folderId] })], { type: 'application/json' }));
  form.append('file', new Blob([pdfBytes], { type: 'application/pdf' }));

  const up = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
    { method: 'POST', headers: { Authorization: `Bearer ${access_token}` }, body: form }
  );
  const { id } = await up.json();
  return id || null;
}
