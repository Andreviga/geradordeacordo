'use strict';
const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

// ── .env.local loader ─────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '../.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val   = t.slice(eq + 1).trim();
    if ((val[0] === '"' && val.at(-1) === '"') || (val[0] === "'" && val.at(-1) === "'"))
      val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

// ── Conexão ───────────────────────────────────────────────────────────────────
function criarCliente() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(
    'Variável DATABASE_URL não encontrada.\n' +
    '  Defina-a no arquivo .env.local (desenvolvimento) ou\n' +
    '  nas variáveis de ambiente do Vercel (produção).'
  );

  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error(
    'DATABASE_URL tem formato inválido.\n' +
    '  Esperado: postgresql://usuario:senha@host/banco?sslmode=require\n' +
    '  Copie a connection string diretamente do painel do Neon.'
  ); }

  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  // Remove sslmode da URL: pg >=8 emite aviso ao parsear sslmode=require/prefer/verify-ca.
  // SSL é configurado explicitamente abaixo; rejectUnauthorized:true valida CA normalmente.
  parsed.searchParams.delete('sslmode');
  return new Client({
    connectionString: parsed.toString(),
    ssl: local ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 12000,
  });
}

async function conectar(client) {
  try {
    await client.connect();
  } catch (err) {
    const m = err.message || '';
    if (m.includes('password authentication failed') || m.includes('28P01'))
      throw new Error('Credencial incorreta. Verifique usuário e senha na DATABASE_URL.');
    if (m.includes('ECONNREFUSED') || m.includes('ENOTFOUND') || m.includes('ETIMEDOUT'))
      throw new Error(
        'Não foi possível conectar ao banco.\n' +
        '  Verifique o host na DATABASE_URL e se há acesso à internet.'
      );
    if (m.toLowerCase().includes('ssl'))
      throw new Error('Erro de SSL na conexão. O banco exige SSL e o driver não conseguiu negociar.');
    if (m.includes('does not exist') || m.includes('3D000'))
      throw new Error(
        'Banco de dados não encontrado.\n' +
        '  Verifique o nome do banco no final da DATABASE_URL (ex: /neondb).'
      );
    throw new Error(`Erro de conexão: ${m}`);
  }
}

// ── Output ────────────────────────────────────────────────────────────────────
function criarColeta() {
  let erros = 0;
  return {
    ok(label)               { process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`); },
    erro(label, detalhe) {
      erros++;
      process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}\n`);
      if (detalhe) process.stdout.write(`      → ${detalhe}\n`);
    },
    get total() { return erros; },
  };
}

// ── Checks estruturais (somente leitura) ──────────────────────────────────────
async function runEstruturais(client, R) {
  const TABELAS = [
    'usuarios','devedores','credoras','alunos','acordos',
    'acordo_devedores','acordo_credoras','acordo_alunos',
    'parcelas','lembretes_enviados','eventos_webhook','auditoria_exclusoes',
    'acordo_numero_seq',
  ];
  const { rows: tFalt } = await client.query(
    `SELECT t FROM unnest($1::text[]) t
     WHERE t NOT IN (SELECT table_name FROM information_schema.tables WHERE table_schema='public')`,
    [TABELAS]
  );
  tFalt.length === 0
    ? R.ok(`Tabelas: todas as ${TABELAS.length} encontradas`)
    : R.erro('Tabelas: faltando', tFalt.map(r => r.t).join(', '));

  const VIEWS = ['parcelas_com_status','acordos_com_status','devedores_sem_email'];
  const { rows: vFalt } = await client.query(
    `SELECT v FROM unnest($1::text[]) v
     WHERE v NOT IN (SELECT table_name FROM information_schema.views WHERE table_schema='public')`,
    [VIEWS]
  );
  vFalt.length === 0
    ? R.ok(`Views: todas as ${VIEWS.length} encontradas`)
    : R.erro('Views: faltando', vFalt.map(r => r.v).join(', '));

  const INDICES = [
    'idx_parcelas_acordo','idx_parcelas_vencimento','idx_parcelas_cron',
    'idx_devedores_email','idx_acordo_devedores_devedor','idx_acordo_credoras_credora',
    'idx_acordo_alunos_aluno','idx_lembretes_parcela','idx_lembretes_reprocessar',
    'idx_acordos_cancelado','idx_acordos_criado_por',
  ];
  const { rows: iFalt } = await client.query(
    `SELECT i FROM unnest($1::text[]) i
     WHERE i NOT IN (SELECT indexname FROM pg_indexes WHERE schemaname='public')`,
    [INDICES]
  );
  iFalt.length === 0
    ? R.ok(`Índices: todos os ${INDICES.length} encontrados`)
    : R.erro('Índices: faltando', iFalt.map(r => r.i).join(', '));

  const FUNCOES = ['app_user_id','app_user_ativo','app_user_admin'];
  const { rows: fFalt } = await client.query(
    `SELECT f FROM unnest($1::text[]) f
     WHERE f NOT IN (
       SELECT routine_name FROM information_schema.routines
       WHERE routine_schema='public' AND routine_type='FUNCTION'
     )`,
    [FUNCOES]
  );
  fFalt.length === 0
    ? R.ok('Funções auxiliares: 3 encontradas')
    : R.erro('Funções auxiliares: faltando', fFalt.map(r => r.f).join(', '));

  const { rows: tipos } = await client.query(`
    SELECT c.table_name||'.'||c.column_name AS col,
           c.data_type AS encontrado, e.tipo AS esperado
    FROM information_schema.columns c
    JOIN (VALUES
      ('parcelas','valor_previsto_cts','bigint'),
      ('parcelas','valor_pago_cts','bigint'),
      ('parcelas','vencimento','date'),
      ('parcelas','renegociada','boolean'),
      ('parcelas','tratamento_manual','boolean'),
      ('lembretes_enviados','devedor_id','uuid'),
      ('lembretes_enviados','tentativas','integer'),
      ('devedores','email_valido','boolean'),
      ('acordos','cancelado','boolean'),
      ('acordos','snapshot_assinatura_json','jsonb')
    ) AS e(tbl,col,tipo) ON c.table_name=e.tbl AND c.column_name=e.col
    WHERE c.table_schema='public' AND c.data_type<>e.tipo
  `);
  tipos.length === 0
    ? R.ok('Tipos de colunas: todos corretos')
    : R.erro('Tipos de colunas: divergências',
        tipos.map(r => `${r.col}: ${r.encontrado} ≠ ${r.esperado}`).join('; '));

  const { rows: notNull } = await client.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='lembretes_enviados'
      AND column_name='devedor_id' AND is_nullable<>'YES'
  `);
  notNull.length === 0
    ? R.ok('devedor_id nullable: OK (compatível com exclusão por LGPD)')
    : R.erro('devedor_id NOT NULL — incompatível com exclusão por LGPD');

  const { rows: semWhere } = await client.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname='public'
      AND indexname IN ('idx_parcelas_cron','idx_devedores_email',
                        'idx_lembretes_reprocessar','idx_acordos_cancelado')
      AND indexdef NOT LIKE '%WHERE%'
  `);
  semWhere.length === 0
    ? R.ok('Índices parciais: todos com cláusula WHERE')
    : R.erro('Índices parciais: faltando WHERE', semWhere.map(r => r.indexname).join(', '));

  // Constraints nomeadas
  const CONSTRAINTS = [
    ['usuarios_email_unique',         'usuarios'],
    ['devedores_cpf_unique',          'devedores'],
    ['credoras_cnpj_unique',          'credoras'],
    ['acordos_numero_unique',         'acordos'],
    ['acordos_zapsign_unique',        'acordos'],
    ['parcelas_numero_unique',        'parcelas'],
    ['lembretes_unique',              'lembretes_enviados'],
    ['eventos_webhook_token_unique',  'eventos_webhook'],
  ];
  const { rows: cFalt } = await client.query(
    `SELECT t.nome, t.tabela
     FROM unnest($1::text[], $2::text[]) AS t(nome, tabela)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_constraint pc JOIN pg_class cls ON pc.conrelid=cls.oid
       WHERE pc.conname=t.nome AND cls.relname=t.tabela AND cls.relkind='r'
     )`,
    [CONSTRAINTS.map(c => c[0]), CONSTRAINTS.map(c => c[1])]
  );
  cFalt.length === 0
    ? R.ok(`Constraints únicas: todas as ${CONSTRAINTS.length} encontradas`)
    : R.erro('Constraints únicas: faltando', cFalt.map(r => `${r.nome} (${r.tabela})`).join(', '));

  return tFalt.length; // retorna nº de tabelas faltando para decidir se roda comportamentais
}

// ── Checks comportamentais (INSERT em transação revertida) ────────────────────
async function runComportamentais(client, R) {
  const crypto = require('crypto');
  let spN = 0;              // contador de savepoints; garante identificadores SQL válidos
  let currentCheck = '';    // rastreia o check em andamento para mensagens de erro

  // Datas relativas em UTC para coincidir com CURRENT_DATE do Neon (fuso UTC)
  function relDate(offsetDays) {
    const d = new Date();
    const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offsetDays);
    return new Date(ms).toISOString().slice(0, 10);
  }

  // Usa SAVEPOINT numerado (sp1, sp2…) — sem texto livre para evitar erro de sintaxe SQL.
  // Label legível fica só na mensagem impressa.
  async function testUnique(label, insertFn) {
    const sp = `sp${++spN}`;
    await client.query(`SAVEPOINT ${sp}`);
    let ok = false;
    try { await insertFn(); }
    catch (e) {
      if (e.code === '23505') ok = true;
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    }
    if (ok) R.ok(`UNIQUE ${label}: rejeita duplicata`);
    else     R.erro(`UNIQUE ${label}: duplicata aceita — constraint ausente`);
  }

  const V = {
    user:   crypto.randomUUID(),
    dev:    crypto.randomUUID(),
    cred:   crypto.randomUUID(),
    acordo: crypto.randomUUID(),
    p1:     crypto.randomUUID(), // vencido
    p2:     crypto.randomUUID(), // a_vencer
    p3:     crypto.randomUUID(), // pago
    p4:     crypto.randomUUID(), // pago_parcial
    p5:     crypto.randomUUID(), // renegociada
    rasc:   crypto.randomUUID(), // rascunho (acordo sem parcelas)
  };

  await client.query('BEGIN');
  try {
    currentCheck = 'inserir dados de teste';
    await client.query(
      `INSERT INTO usuarios (id,nome,email,hash_senha,papel) VALUES ($1,'Verify','verify@test.local','x','admin')`,
      [V.user]
    );
    await client.query(`INSERT INTO devedores (id,nome,cpf) VALUES ($1,'Dev Verify','111.111.111-11')`, [V.dev]);
    await client.query(`INSERT INTO credoras  (id,nome,tipo) VALUES ($1,'Cred Verify','pj')`, [V.cred]);
    await client.query(`INSERT INTO acordos (id,valor_total_cts,criado_por) VALUES ($1,250000,$2)`, [V.acordo, V.user]);
    await client.query(`INSERT INTO acordo_devedores (acordo_id,devedor_id) VALUES ($1,$2)`, [V.acordo, V.dev]);

    const parcelas = [
      { id: V.p1, num: 1, venc: relDate(-10), prev: 50000, pago: null,  dpag: null,         reneg: false },
      { id: V.p2, num: 2, venc: relDate(+5),  prev: 50000, pago: null,  dpag: null,         reneg: false },
      { id: V.p3, num: 3, venc: relDate(-30), prev: 50000, pago: 50000, dpag: relDate(-29), reneg: false },
      { id: V.p4, num: 4, venc: relDate(-20), prev: 50000, pago: 20000, dpag: null,         reneg: false },
      { id: V.p5, num: 5, venc: relDate(-5),  prev: 50000, pago: null,  dpag: null,         reneg: true  },
    ];
    for (const p of parcelas) {
      await client.query(
        `INSERT INTO parcelas
           (id,acordo_id,numero,vencimento,valor_previsto_cts,valor_pago_cts,data_pagamento,renegociada)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [p.id, V.acordo, p.num, p.venc, p.prev, p.pago, p.dpag, p.reneg]
      );
    }

    // 1. Status das parcelas
    currentCheck = 'status das parcelas';
    const ESPERADO = {
      [V.p1]:'vencido', [V.p2]:'a_vencer', [V.p3]:'pago',
      [V.p4]:'pago_parcial', [V.p5]:'renegociada',
    };
    const { rows: st } = await client.query(
      `SELECT id::text, status FROM parcelas_com_status WHERE id=ANY($1::uuid[])`,
      [Object.keys(ESPERADO)]
    );
    const stErr = st.filter(r => r.status !== ESPERADO[r.id]);
    stErr.length === 0
      ? R.ok('Status das parcelas: vencido, a_vencer, pago, pago_parcial, renegociada — corretos')
      : R.erro('Status das parcelas: divergências',
          stErr.map(r => `${r.id.slice(-4)}: ${r.status} ≠ ${ESPERADO[r.id]}`).join('; '));

    // 2. Aritmética de datas (deve retornar integer, não interval)
    currentCheck = 'aritmética de datas';
    const DIAS = { [V.p1]:-10, [V.p2]:5, [V.p3]:-30, [V.p5]:-5 };
    const { rows: dt2 } = await client.query(
      `SELECT id::text, dias_para_vencimento::int AS d, pg_typeof(dias_para_vencimento)::text AS t
       FROM parcelas_com_status WHERE id=ANY($1::uuid[])`,
      [Object.keys(DIAS)]
    );
    const dtErr = dt2.filter(r => r.d !== DIAS[r.id] || r.t !== 'integer');
    dtErr.length === 0
      ? R.ok('Aritmética de datas: retorna integer, valores corretos')
      : R.erro('Aritmética de datas: divergências',
          dtErr.map(r => `${r.id.slice(-4)}: ${r.d} (${r.t})`).join('; '));

    // 3. Saldo em centavos
    currentCheck = 'saldo em centavos';
    const SALDO = { [V.p1]:50000, [V.p2]:50000, [V.p3]:0, [V.p4]:30000, [V.p5]:50000 };
    const { rows: sl } = await client.query(
      `SELECT id::text, saldo_cts::int AS s FROM parcelas_com_status WHERE id=ANY($1::uuid[])`,
      [Object.keys(SALDO)]
    );
    const slErr = sl.filter(r => r.s !== SALDO[r.id]);
    slErr.length === 0
      ? R.ok('Saldo em centavos: correto para todos os cenários')
      : R.erro('Saldo em centavos: divergências',
          slErr.map(r => `${r.id.slice(-4)}: ${r.s} ≠ ${SALDO[r.id]}`).join('; '));

    // 4. Status do acordo — inadimplente
    currentCheck = 'status do acordo inadimplente';
    const { rows: acSt } = await client.query(
      `SELECT status FROM acordos_com_status WHERE id=$1::uuid`, [V.acordo]
    );
    acSt[0]?.status === 'inadimplente'
      ? R.ok('Status do acordo: inadimplente (tem parcela vencida)')
      : R.erro('Status do acordo', `esperado inadimplente, encontrado ${acSt[0]?.status}`);

    // 5. Status rascunho
    currentCheck = 'status do acordo rascunho';
    await client.query(`INSERT INTO acordos (id,valor_total_cts) VALUES ($1::uuid,1)`, [V.rasc]);
    const { rows: rasc } = await client.query(
      `SELECT status FROM acordos_com_status WHERE id=$1::uuid`, [V.rasc]
    );
    rasc[0]?.status === 'rascunho'
      ? R.ok('Status do acordo sem parcelas: rascunho')
      : R.erro('Status rascunho', `esperado rascunho, encontrado ${rasc[0]?.status}`);

    // ── Meta-teste extraído — corre só via db:selftest, não em status rotineiro.
    // (removido daqui para manter db:status leve e sem DDL em produção)

    // ── Checks de constraints UNIQUE ──────────────────────────────────────────
    currentCheck = 'UNIQUE devedores.cpf';
    await testUnique('devedores.cpf', () =>
      client.query(`INSERT INTO devedores (nome,cpf) VALUES ('X','111.111.111-11')`)
    );

    currentCheck = 'UNIQUE parcelas(acordo_id, numero)';
    await testUnique('parcelas(acordo_id, numero)', () =>
      client.query(
        `INSERT INTO parcelas (acordo_id,numero,vencimento,valor_previsto_cts) VALUES ($1,$2,$3,1)`,
        [V.acordo, 1, relDate(99)] // numero=1 já existe para V.acordo
      )
    );

    currentCheck = 'UNIQUE lembretes_enviados';
    await client.query(
      `INSERT INTO lembretes_enviados (parcela_id,devedor_id,evento,destinatario,status)
       VALUES ($1,$2,'D-3','test@test.com','ok')`,
      [V.p1, V.dev]
    );
    await testUnique('lembretes_enviados(parcela_id,evento,devedor_id)', () =>
      client.query(
        `INSERT INTO lembretes_enviados (parcela_id,devedor_id,evento,destinatario,status)
         VALUES ($1,$2,'D-3','outro@test.com','ok')`,
        [V.p1, V.dev]
      )
    );

  } catch (err) {
    throw new Error(`Falhou em "${currentCheck}": ${err.message}`);
  } finally {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
  }
}

// ── Self-test do mecanismo de SAVEPOINT (chamado só por db:selftest) ─────────
// Confirma que DROP CONSTRAINT + ROLLBACK TO SAVEPOINT restaura a constraint.
async function runSelfTest(client, R) {
  await client.query('BEGIN');
  try {
    const sp = 'sp_selftest';
    await client.query(`SAVEPOINT ${sp}`);
    let metaDetectouAusencia = false;
    try {
      await client.query('ALTER TABLE devedores DROP CONSTRAINT IF EXISTS devedores_cpf_unique');
      await client.query(`INSERT INTO devedores (nome,cpf) VALUES ('MetaA','000.000.000-00')`);
      await client.query(`INSERT INTO devedores (nome,cpf) VALUES ('MetaB','000.000.000-00')`);
      metaDetectouAusencia = true;
    } finally {
      // Garantido mesmo em caso de exceção nos INSERTs
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    }

    // Verificação explícita de que a constraint voltou — falha ruidosa se não voltou
    const { rows: cv } = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname='devedores_cpf_unique'`
    );
    if (cv.length === 0)
      throw new Error(
        'ROLLBACK TO SAVEPOINT não restaurou devedores_cpf_unique. ' +
        'Estado do banco inconsistente — abortar toda validação.'
      );

    if (!metaDetectouAusencia)
      R.erro('Meta-teste', 'DROP CONSTRAINT não teve efeito — verificar permissões DDL');
    else
      R.ok('Meta-teste SAVEPOINT: DROP+INSERT+ROLLBACK restaurou constraint — mecanismo validado');
  } finally {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
  }
}

module.exports = { loadEnv, criarCliente, conectar, criarColeta, runEstruturais, runComportamentais, runSelfTest };
