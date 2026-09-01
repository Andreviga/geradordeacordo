'use strict';
// api/cron/index.js — os dois crons numa função só.
//
//   GET|POST /api/cron/lembretes   → lembretes de vencimento (seg–sex, 12h UTC)
//   GET|POST /api/cron/backup      → dump do banco no Drive (seg, 06h UTC)
//
// As URLs continuam as mesmas: o vercel.json reescreve /api/cron/:job para
// /api/cron?job=:job. Foi preciso porque o roteamento por sistema de arquivos do
// Vercel não entrega sub-rotas para dir/index.js — o mesmo motivo dos rewrites
// de acordos e parcelas (ver api/_rota.js).
//
// Por que estão juntas: o plano Hobby limita a 12 funções serverless por
// deployment e estávamos em 12/12. Fundir as duas libera um slot. São as
// candidatas mais naturais: mesma autenticação (CRON_SECRET), mesmos métodos,
// nenhuma lógica compartilhada com o resto do sistema, e o trabalho pesado já
// vive nos motores (_lembretes_engine.js e _backup_engine.js).
//
// Autenticação: Authorization: Bearer $CRON_SECRET.
// O scheduler do Vercel dispara com GET e manda o segredo nesse header. Recusar
// GET fazia os dois crons responderem 405 a cada execução — confirmado em
// produção — e nada jamais rodava. POST segue aceito para invocação manual.

const crypto = require('crypto');
const { getPool } = require('../_db');

// 'retencao' existe como endpoint mas NÃO está agendado no vercel.json: apaga
// dado pessoal em definitivo, então só roda quando alguém pedir. Ver README.
const JOBS = ['lembretes', 'backup', 'retencao'];

/** Nome do job: vem do rewrite (?job=) ou, se ele falhar, da própria URL. */
function jobDaRota(req) {
  const doRewrite = String((req.query && req.query.job) || '').trim();
  if (doRewrite) return doRewrite;
  const caminho = String(req.url || '').split('?')[0];
  return caminho.replace(/^\/api\/cron\/?/, '').split('/').filter(Boolean)[0] || '';
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  // Autenticação antes de escolher o ramo, e antes de revelar se o job existe.
  //
  // 503 e 401 são casos diferentes e antes eram o mesmo: segredo ausente no
  // servidor é erro de configuração, não credencial errada. Como os dois davam
  // 401, uma execução que falhava não dizia se faltava a variável ou se o header
  // não estava chegando — e o backup ficou semanas sem rodar sem que se soubesse
  // por quê.
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret)
    return res.status(503).json({ error: 'CRON_SECRET não configurado no servidor.' });

  // O trim dos dois lados evita a pegadinha de colar o segredo no painel com
  // quebra de linha no fim: invisível, e faz a comparação falhar para sempre.
  const recebido = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(recebido), b = Buffer.from(secret);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok)
    return res.status(401).json({ error: 'Unauthorized', dica: 'Envie Authorization: Bearer $CRON_SECRET' });

  const job = jobDaRota(req);
  if (!JOBS.includes(job))
    return res.status(404).json({ error: `Job desconhecido. Aceito: ${JOBS.join(', ')}` });

  // Backup e retenção precisam do banco; os lembretes abrem a conexão sozinhos
  let pool = null;
  if (job === 'backup' || job === 'retencao') {
    pool = getPool();
    if (!pool) return res.status(503).json({ error: 'DATABASE_URL não configurado' });
  }

  try {
    let result;
    if (job === 'lembretes') {
      const { executarLembretes } = require('./_lembretes_engine');
      result = await executarLembretes({ dryRun: false });
    } else if (job === 'backup') {
      const { executarBackup } = require('./_backup_engine');
      result = await executarBackup(pool);
    } else {
      // Expurgo é irreversível: por HTTP só roda em modo ensaio, a menos que a
      // chamada peça explicitamente ?aplicar=1. Assim uma chamada acidental —
      // ou um agendamento posto sem querer — não apaga nada.
      const { executarRetencao } = require('./_retencao_engine');
      const aplicar = String(req.query?.aplicar || '') === '1';
      result = await executarRetencao(pool, { dryRun: !aplicar });
    }
    console.log(`[cron/${job}] concluído:`, result);
    return res.status(200).json(result);
  } catch (err) {
    console.error(`[cron/${job}] erro:`, err.message);
    return res.status(500).json({ error: err.message });
  }
};

module.exports.jobDaRota = jobDaRota;
module.exports.JOBS      = JOBS;
