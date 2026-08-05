-- ══════════════════════════════════════════════════════════════════════════════
-- verify.sql  —  Fase E, Etapa 1
-- ══════════════════════════════════════════════════════════════════════════════
-- Roda dentro de uma transação revertida. Todos os INSERT são descartados
-- pelo ROLLBACK final — nunca modifica dados em produção.
--
-- Uso:   psql $DATABASE_URL < db/verify.sql
-- Saída: 0 linhas em cada seção "esperado: 0 linhas" = schema correto.
--        NOTICEs de constraint são parte do teste (esperados).
--        Qualquer linha de resultado fora dos NOTICEs indica problema.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- IDs de teste fixos — descartados no ROLLBACK
\set v_user   '''00000000-0000-0000-0000-000000000099'''
\set v_dev    '''00000000-0000-0000-0000-000000000010'''
\set v_cred   '''00000000-0000-0000-0000-000000000020'''
\set v_acordo '''00000000-0000-0000-0000-000000000030'''
\set v_p1     '''00000000-0000-0000-0000-000000000041'''
\set v_p2     '''00000000-0000-0000-0000-000000000042'''
\set v_p3     '''00000000-0000-0000-0000-000000000043'''
\set v_p4     '''00000000-0000-0000-0000-000000000044'''
\set v_p5     '''00000000-0000-0000-0000-000000000045'''

-- ─── 1. Tabelas ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== 1. Tabelas ausentes (esperado: 0 linhas) ==='
SELECT t AS tabela_ausente
FROM unnest(ARRAY[
  'usuarios','devedores','credoras','alunos','acordos',
  'acordo_devedores','acordo_credoras','acordo_alunos',
  'parcelas','lembretes_enviados','eventos_webhook','auditoria_exclusoes'
]) t
WHERE t NOT IN (
  SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
);

-- ─── 2. Views ───────────────────────────────────────────────────────────────
\echo '=== 2. Views ausentes (esperado: 0 linhas) ==='
SELECT v AS view_ausente
FROM unnest(ARRAY['parcelas_com_status','acordos_com_status','devedores_sem_email']) v
WHERE v NOT IN (
  SELECT table_name FROM information_schema.views WHERE table_schema = 'public'
);

-- ─── 3. Índices ─────────────────────────────────────────────────────────────
\echo '=== 3. Índices ausentes (esperado: 0 linhas) ==='
SELECT i AS indice_ausente
FROM unnest(ARRAY[
  'idx_parcelas_acordo','idx_parcelas_vencimento','idx_parcelas_cron',
  'idx_devedores_email','idx_acordo_devedores_devedor','idx_acordo_credoras_credora',
  'idx_acordo_alunos_aluno','idx_lembretes_parcela','idx_lembretes_reprocessar',
  'idx_acordos_cancelado','idx_acordos_criado_por'
]) i
WHERE i NOT IN (SELECT indexname FROM pg_indexes WHERE schemaname = 'public');

-- ─── 4. Funções auxiliares ──────────────────────────────────────────────────
\echo '=== 4. Funções ausentes (esperado: 0 linhas) ==='
SELECT f AS funcao_ausente
FROM unnest(ARRAY['app_user_id','app_user_ativo','app_user_admin']) f
WHERE f NOT IN (
  SELECT routine_name FROM information_schema.routines
  WHERE routine_schema = 'public' AND routine_type = 'FUNCTION'
);

-- ─── 5. Tipos de colunas ────────────────────────────────────────────────────
\echo '=== 5. Tipos divergentes (esperado: 0 linhas) ==='
SELECT c.table_name || '.' || c.column_name AS coluna,
       c.data_type AS encontrado, e.tipo AS esperado
FROM information_schema.columns c
JOIN (VALUES
  ('parcelas',           'valor_previsto_cts',      'bigint'),
  ('parcelas',           'valor_pago_cts',           'bigint'),
  ('parcelas',           'vencimento',               'date'),
  ('parcelas',           'renegociada',              'boolean'),
  ('parcelas',           'tratamento_manual',        'boolean'),
  ('lembretes_enviados', 'devedor_id',               'uuid'),
  ('lembretes_enviados', 'tentativas',               'integer'),
  ('devedores',          'email_valido',             'boolean'),
  ('acordos',            'cancelado',                'boolean'),
  ('acordos',            'snapshot_assinatura_json', 'jsonb')
) AS e(tbl, col, tipo) ON c.table_name = e.tbl AND c.column_name = e.col
WHERE c.table_schema = 'public' AND c.data_type <> e.tipo;

\echo '=== 5b. devedor_id nullable (esperado: 0 linhas) ==='
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'lembretes_enviados'
  AND column_name = 'devedor_id' AND is_nullable <> 'YES';

-- ─── 6. Dados de teste ──────────────────────────────────────────────────────
\echo ''
\echo '=== Inserindo dados de teste (revertidos no ROLLBACK) ==='

INSERT INTO usuarios (id, nome, email, hash_senha, papel)
VALUES (:v_user::uuid, 'Verify SQL', 'verify@test.local', 'x', 'admin');

INSERT INTO devedores (id, nome, cpf)
VALUES (:v_dev::uuid, 'Devedor Verify', '123.456.789-09');

INSERT INTO credoras (id, nome, tipo)
VALUES (:v_cred::uuid, 'Credora Verify', 'pj');

INSERT INTO acordos (id, valor_total_cts, criado_por)
VALUES (:v_acordo::uuid, 250000, :v_user::uuid);

INSERT INTO acordo_devedores (acordo_id, devedor_id)
VALUES (:v_acordo::uuid, :v_dev::uuid);

-- p1: vencido — 10 dias atrás, sem pagamento
INSERT INTO parcelas (id, acordo_id, numero, vencimento, valor_previsto_cts)
VALUES (:v_p1::uuid, :v_acordo::uuid, 1, CURRENT_DATE - 10, 50000);

-- p2: a_vencer — vencimento daqui a 5 dias, sem pagamento
INSERT INTO parcelas (id, acordo_id, numero, vencimento, valor_previsto_cts)
VALUES (:v_p2::uuid, :v_acordo::uuid, 2, CURRENT_DATE + 5, 50000);

-- p3: pago — valor_pago = valor_previsto
INSERT INTO parcelas (id, acordo_id, numero, vencimento, valor_previsto_cts,
                      valor_pago_cts, data_pagamento)
VALUES (:v_p3::uuid, :v_acordo::uuid, 3, CURRENT_DATE - 30, 50000, 50000, CURRENT_DATE - 29);

-- p4: pago_parcial — pagamento parcial (20000 de 50000), já vencida
INSERT INTO parcelas (id, acordo_id, numero, vencimento, valor_previsto_cts, valor_pago_cts)
VALUES (:v_p4::uuid, :v_acordo::uuid, 4, CURRENT_DATE - 20, 50000, 20000);

-- p5: renegociada — flag true, independente de vencimento ou pagamento
INSERT INTO parcelas (id, acordo_id, numero, vencimento, valor_previsto_cts, renegociada)
VALUES (:v_p5::uuid, :v_acordo::uuid, 5, CURRENT_DATE - 5, 50000, true);

-- ─── 7. Status derivado das parcelas ────────────────────────────────────────
\echo ''
\echo '=== 7. Status das parcelas (esperado: 0 divergências) ==='
SELECT pcs.id,
       pcs.status AS encontrado,
       e.esperado
FROM parcelas_com_status pcs
JOIN (VALUES
  (:v_p1::uuid, 'vencido'),
  (:v_p2::uuid, 'a_vencer'),
  (:v_p3::uuid, 'pago'),
  (:v_p4::uuid, 'pago_parcial'),
  (:v_p5::uuid, 'renegociada')
) AS e(pid, esperado) ON pcs.id = e.pid
WHERE pcs.status <> e.esperado;

-- ─── 8. Aritmética de datas retorna INTEGER ─────────────────────────────────
\echo '=== 8. dias_para_vencimento: valor e tipo (esperado: 0 divergências) ==='
SELECT pcs.id,
       pcs.dias_para_vencimento AS encontrado,
       e.esperado,
       pg_typeof(pcs.dias_para_vencimento)::text AS tipo_pg
FROM parcelas_com_status pcs
JOIN (VALUES
  (:v_p1::uuid, -10),
  (:v_p2::uuid,   5),
  (:v_p3::uuid, -30),
  (:v_p5::uuid,  -5)
) AS e(pid, esperado) ON pcs.id = e.pid
WHERE pcs.dias_para_vencimento <> e.esperado
   OR pg_typeof(pcs.dias_para_vencimento)::text <> 'integer';

-- ─── 9. Saldo em centavos ───────────────────────────────────────────────────
\echo '=== 9. saldo_cts (esperado: 0 divergências) ==='
SELECT pcs.id, pcs.saldo_cts AS encontrado, e.esperado
FROM parcelas_com_status pcs
JOIN (VALUES
  (:v_p1::uuid, 50000::bigint),  -- sem pagamento: saldo = previsto
  (:v_p2::uuid, 50000::bigint),
  (:v_p3::uuid,     0::bigint),  -- pago integral: saldo = 0
  (:v_p4::uuid, 30000::bigint),  -- 50000 - 20000
  (:v_p5::uuid, 50000::bigint)   -- renegociada: saldo = previsto (não zerado pela view)
) AS e(pid, esperado) ON pcs.id = e.pid
WHERE pcs.saldo_cts <> e.esperado;

-- ─── 10. Status do acordo ───────────────────────────────────────────────────
\echo '=== 10. Status do acordo = inadimplente (tem parcela vencida) (esperado: 0 linhas) ==='
SELECT id, status AS encontrado
FROM acordos_com_status
WHERE id = :v_acordo::uuid AND status <> 'inadimplente';

-- ─── 11. Constraints únicas ─────────────────────────────────────────────────
\echo ''
\echo '=== 11a. UNIQUE CPF duplicado deve ser rejeitado (esperado: NOTICE "OK") ==='
DO $$
BEGIN
  INSERT INTO devedores (nome, cpf) VALUES ('Duplicado', '123.456.789-09');
  RAISE EXCEPTION 'FALHA: CPF duplicado foi aceito';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE '11a OK: UNIQUE devedores.cpf rejeitou duplicata';
END $$;

\echo '=== 11b. UNIQUE (acordo_id, numero) duplicado deve ser rejeitado ==='
DO $$
BEGIN
  INSERT INTO parcelas (acordo_id, numero, vencimento, valor_previsto_cts)
  VALUES ('00000000-0000-0000-0000-000000000030'::uuid, 1, CURRENT_DATE + 99, 1);
  RAISE EXCEPTION 'FALHA: parcela (acordo_id, numero) duplicada foi aceita';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE '11b OK: UNIQUE (acordo_id, numero) rejeitou duplicata';
END $$;

\echo '=== 11c. UNIQUE zapsign_token duplicado deve ser rejeitado ==='
DO $$
BEGIN
  -- Atualiza o acordo de teste com um token e tenta inserir outro com o mesmo
  UPDATE acordos SET zapsign_token = 'tok-verify-test'
  WHERE id = '00000000-0000-0000-0000-000000000030'::uuid;
  INSERT INTO acordos (valor_total_cts, zapsign_token)
  VALUES (1, 'tok-verify-test');
  RAISE EXCEPTION 'FALHA: zapsign_token duplicado foi aceito';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE '11c OK: UNIQUE acordos.zapsign_token rejeitou duplicata';
END $$;

-- ─── 12. acordo sem parcelas = rascunho ─────────────────────────────────────
\echo ''
\echo '=== 12. Acordo sem parcelas = rascunho (esperado: 0 linhas) ==='
INSERT INTO acordos (id, valor_total_cts) VALUES
  ('00000000-0000-0000-0000-000000000031'::uuid, 100000);
SELECT id, status AS encontrado
FROM acordos_com_status
WHERE id = '00000000-0000-0000-0000-000000000031'::uuid
  AND status <> 'rascunho';

-- ─── 13. Índices parciais definidos com WHERE correto ───────────────────────
\echo '=== 13. Índices parciais têm cláusula WHERE (esperado: 0 sem WHERE) ==='
SELECT indexname AS indice_sem_where
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('idx_parcelas_cron','idx_devedores_email',
                    'idx_lembretes_reprocessar','idx_acordos_cancelado')
  AND indexdef NOT LIKE '%WHERE%';

-- ─────────────────────────────────────────────────────────────────────────────
ROLLBACK;

\echo ''
\echo '══════════════════════════════════════════════════════════════════════'
\echo 'verify.sql concluído. 0 linhas em cada seção = schema correto.'
\echo 'NOTICEs "OK" acima são esperados (confirmam constraints únicas).'
\echo '══════════════════════════════════════════════════════════════════════'
