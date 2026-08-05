-- ══════════════════════════════════════════════════════════════════════════════
-- schema.sql  —  Gerador de Acordo | Fase E | Etapa 1
-- ══════════════════════════════════════════════════════════════════════════════
-- Aplicar: psql $DATABASE_URL < db/schema.sql
-- Idempotente: pode ser reaplicado sem erro (IF NOT EXISTS em tabelas e índices;
-- CREATE OR REPLACE em funções e views).
-- Sem DROP TABLE em nenhum ponto deste arquivo.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tabelas
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS usuarios (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  hash_senha    TEXT        NOT NULL,
  papel         TEXT        NOT NULL DEFAULT 'secretaria'
                              CHECK (papel IN ('secretaria', 'admin')),
  ativo         BOOLEAN     NOT NULL DEFAULT true,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultimo_acesso TIMESTAMPTZ,
  CONSTRAINT usuarios_email_unique UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS devedores (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  nome           TEXT        NOT NULL,
  cpf            TEXT        NOT NULL,
  rg             TEXT,
  rg_emissor     TEXT,
  nacionalidade  TEXT,
  estado_civil   TEXT,
  profissao      TEXT,
  end_logradouro TEXT,
  end_cep        TEXT,
  end_cidade     TEXT,
  email          TEXT,
  -- false quando ZapSign reportar evento email_bounce
  email_valido   BOOLEAN     NOT NULL DEFAULT true,
  telefone       TEXT,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT devedores_cpf_unique UNIQUE (cpf)
);

CREATE TABLE IF NOT EXISTS credoras (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  nome           TEXT        NOT NULL,
  cnpj           TEXT,
  tipo           TEXT        NOT NULL DEFAULT 'pj' CHECK (tipo IN ('pj', 'pf')),
  end_logradouro TEXT,
  end_cidade     TEXT,
  end_uf         TEXT,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT credoras_cnpj_unique UNIQUE (cnpj)
);

CREATE TABLE IF NOT EXISTS alunos (
  id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  nome      TEXT        NOT NULL,
  serie     TEXT,
  turno     TEXT,
  ra        TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS acordos (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  numero                   TEXT,
  cancelado                BOOLEAN     NOT NULL DEFAULT false,
  valor_total_cts          BIGINT      NOT NULL CHECK (valor_total_cts > 0),
  entrada_cts              BIGINT      NOT NULL DEFAULT 0 CHECK (entrada_cts >= 0),
  n_parcelas               INT         CHECK (n_parcelas > 0),
  valor_parcela_cts        BIGINT      CHECK (valor_parcela_cts > 0),
  data_primeira_parcela    DATE,
  multa_mora_pct           NUMERIC(5,2),
  juros_pct                NUMERIC(5,2),
  multa_penal_pct          NUMERIC(5,2),
  honorarios_pct           NUMERIC(5,2),
  indice_correcao          TEXT,
  origem_divida            TEXT,
  periodo_referencia       TEXT,
  foro                     TEXT,
  modo_assinatura          TEXT        NOT NULL DEFAULT 'fisico'
                             CHECK (modo_assinatura IN ('fisico', 'eletronico')),
  zapsign_token            TEXT,
  assinado_em              TIMESTAMPTZ,
  drive_file_id            TEXT,
  -- Imutável após assinatura; prova legal do documento assinado
  snapshot_assinatura_json JSONB,
  -- Desligamento explícito (renegociacao | judicial | obito | outro)
  lembretes_ativos         BOOLEAN     NOT NULL DEFAULT true,
  lembretes_desativado_por TEXT,
  -- Chave de idempotência gerada pelo cliente; impede duplicatas por double-submit ou refresh
  idempotency_key          UUID,
  -- Data jurídica do acordo (pode ser anterior a criado_em em importações retroativas)
  data_assinatura          DATE,
  acordo_pai_id            UUID        REFERENCES acordos(id),
  criado_por               UUID        REFERENCES usuarios(id),
  criado_em                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT acordos_numero_unique  UNIQUE (numero),
  CONSTRAINT acordos_zapsign_unique UNIQUE (zapsign_token)
);

CREATE TABLE IF NOT EXISTS acordo_devedores (
  acordo_id  UUID NOT NULL REFERENCES acordos(id)  ON DELETE CASCADE,
  devedor_id UUID NOT NULL REFERENCES devedores(id),
  papel      TEXT NOT NULL DEFAULT 'devedor' CHECK (papel IN ('devedor', 'solidario')),
  ordem      INT  NOT NULL DEFAULT 1,
  PRIMARY KEY (acordo_id, devedor_id)
);

CREATE TABLE IF NOT EXISTS acordo_credoras (
  acordo_id     UUID NOT NULL REFERENCES acordos(id) ON DELETE CASCADE,
  credora_id    UUID NOT NULL REFERENCES credoras(id),
  valor_cts     BIGINT,
  representante TEXT,
  cargo         TEXT,
  PRIMARY KEY (acordo_id, credora_id)
);

CREATE TABLE IF NOT EXISTS acordo_alunos (
  acordo_id UUID NOT NULL REFERENCES acordos(id) ON DELETE CASCADE,
  aluno_id  UUID NOT NULL REFERENCES alunos(id),
  PRIMARY KEY (acordo_id, aluno_id)
);

CREATE TABLE IF NOT EXISTS parcelas (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  acordo_id                UUID        NOT NULL REFERENCES acordos(id) ON DELETE CASCADE,
  numero                   INT         NOT NULL CHECK (numero > 0),
  vencimento               DATE        NOT NULL,
  valor_previsto_cts       BIGINT      NOT NULL CHECK (valor_previsto_cts > 0),
  -- Fatos registrados ao receber pagamento; status é derivado pela view
  valor_pago_cts           BIGINT      CHECK (valor_pago_cts >= 0),
  data_pagamento           DATE,
  referencia_pag           TEXT,
  observacao               TEXT,
  registrado_por           UUID        REFERENCES usuarios(id),
  -- Único estado armazenado além dos fatos; marca renegociação explícita
  renegociada              BOOLEAN     NOT NULL DEFAULT false,
  -- Sinaliza parcela para fila de tratamento humano (não desliga o acordo inteiro)
  tratamento_manual        BOOLEAN     NOT NULL DEFAULT false,
  tratamento_manual_motivo TEXT,
  -- Forma de pagamento registrada na baixa
  forma_pagamento          TEXT        CHECK (forma_pagamento IN ('pix','ted','boleto','especie','cartao','cheque','outro')),
  -- Campos de estorno (preenchidos quando a baixa é revertida; valor_pago_cts volta a NULL)
  estornado_em             TIMESTAMPTZ,
  estornado_por            UUID        REFERENCES usuarios(id),
  motivo_estorno           TEXT,
  -- Classificação quando valor_pago_cts > valor_previsto_cts (encargos, adiantamento, etc.)
  classificacao_excedente  TEXT        CHECK (classificacao_excedente IN ('encargos_atraso','adiantamento_parcela','erro_verificar')),
  CONSTRAINT parcelas_numero_unique UNIQUE (acordo_id, numero)
);

CREATE TABLE IF NOT EXISTS lembretes_enviados (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  parcela_id   UUID        NOT NULL REFERENCES parcelas(id)  ON DELETE CASCADE,
  -- NULLABLE: ON DELETE SET NULL preserva o histórico quando o devedor é excluído por LGPD.
  -- Procedimento de exclusão: UPDATE lembretes_enviados SET destinatario='[removido]'
  -- WHERE devedor_id = $id  (antes de deletar o devedor).
  devedor_id   UUID        REFERENCES devedores(id) ON DELETE SET NULL,
  evento       TEXT        NOT NULL CHECK (evento IN ('D-3', 'D+1', 'D+7', 'D+15')),
  canal        TEXT        NOT NULL DEFAULT 'email',
  -- e-mail no momento do envio; histórico imutável independente de edições futuras
  destinatario TEXT        NOT NULL,
  tentativas   INT         NOT NULL DEFAULT 0,
  status       TEXT        NOT NULL DEFAULT 'pendente'
                 CHECK (status IN ('pendente', 'ok', 'falha', 'cancelado')),
  enviado_em   TIMESTAMPTZ,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  erro_msg     TEXT,
  -- D+15+unmark: parcela re-aberta reaparece no cron mas só faz ON CONFLICT (sem escrita).
  CONSTRAINT lembretes_unique UNIQUE (parcela_id, evento, devedor_id)
);

CREATE TABLE IF NOT EXISTS eventos_webhook (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  zapsign_token TEXT        NOT NULL,
  event_type    TEXT        NOT NULL,
  acordo_id     UUID        REFERENCES acordos(id),
  payload_json  JSONB,
  drive_file_id TEXT,
  processado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- UNIQUE garante idempotência atômica sem Set em memória
  CONSTRAINT eventos_webhook_token_unique UNIQUE (zapsign_token)
);

-- Nunca apagada; log permanente de exclusões para LGPD e auditoria
CREATE TABLE IF NOT EXISTS auditoria_exclusoes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tabela       TEXT        NOT NULL,
  registro_id  UUID        NOT NULL,
  excluido_por UUID        REFERENCES usuarios(id),
  motivo       TEXT        NOT NULL,
  excluido_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Numeração sequencial de acordos por ano: INSERT ... ON CONFLICT DO UPDATE é atômico.
-- Nunca usar MAX+1 (race condition). Reseta anualmente sem trigger.
--
-- Decisões de design:
--   Gaps são ACEITÁVEIS: se uma transação falhar após incrementar o contador mas
--   antes do COMMIT, o número é consumido e não volta. Gaps são preferíveis a
--   duplicatas. Nenhuma lei exige numeração contígua.
--
--   Virada de ano: o ano é calculado em javascript (new Date().getFullYear())
--   antes de entrar na transação. Acordos criados nos últimos segundos do ano
--   terão número do ano anterior — comportamento correto e intencional.
--
--   O número é reservado DENTRO da transação, ao mesmo tempo que o INSERT em acordos.
--   Se a transação abortar depois do INSERT em acordo_numero_seq mas antes do COMMIT,
--   o número é perdido (gap). Se abortar antes do INSERT em acordo_numero_seq, nenhum
--   número é consumido.
CREATE TABLE IF NOT EXISTS acordo_numero_seq (
  ano     SMALLINT PRIMARY KEY,
  ultimo  INT      NOT NULL DEFAULT 0
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Constraints nomeadas (idempotentes via DO block)
-- CREATE TABLE IF NOT EXISTS não recria constraints em tabelas que já existiam.
-- Este bloco garante que as constraints existam mesmo em bancos com estado parcial.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='usuarios_email_unique')
    THEN ALTER TABLE usuarios ADD CONSTRAINT usuarios_email_unique UNIQUE (email); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='devedores_cpf_unique')
    THEN ALTER TABLE devedores ADD CONSTRAINT devedores_cpf_unique UNIQUE (cpf); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='credoras_cnpj_unique')
    THEN ALTER TABLE credoras ADD CONSTRAINT credoras_cnpj_unique UNIQUE (cnpj); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='acordos_idempotency_unique')
    THEN
      ALTER TABLE acordos ADD COLUMN IF NOT EXISTS idempotency_key UUID;
      ALTER TABLE acordos ADD CONSTRAINT acordos_idempotency_unique UNIQUE (idempotency_key);
  END IF;
  ALTER TABLE acordos ADD COLUMN IF NOT EXISTS data_assinatura DATE;
  -- Colunas de baixa e estorno em parcelas (adicionadas na Etapa 3)
  ALTER TABLE parcelas ADD COLUMN IF NOT EXISTS forma_pagamento TEXT CHECK (forma_pagamento IN ('pix','ted','boleto','especie','cartao','cheque','outro'));
  ALTER TABLE parcelas ADD COLUMN IF NOT EXISTS estornado_em    TIMESTAMPTZ;
  ALTER TABLE parcelas ADD COLUMN IF NOT EXISTS estornado_por   UUID REFERENCES usuarios(id);
  ALTER TABLE parcelas ADD COLUMN IF NOT EXISTS motivo_estorno  TEXT;
  ALTER TABLE parcelas ADD COLUMN IF NOT EXISTS classificacao_excedente TEXT CHECK (classificacao_excedente IN ('encargos_atraso','adiantamento_parcela','erro_verificar'));
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='acordos_numero_unique')
    THEN ALTER TABLE acordos ADD CONSTRAINT acordos_numero_unique UNIQUE (numero); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='acordos_zapsign_unique')
    THEN ALTER TABLE acordos ADD CONSTRAINT acordos_zapsign_unique UNIQUE (zapsign_token); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='parcelas_numero_unique')
    THEN ALTER TABLE parcelas ADD CONSTRAINT parcelas_numero_unique UNIQUE (acordo_id, numero); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='lembretes_unique')
    THEN ALTER TABLE lembretes_enviados ADD CONSTRAINT lembretes_unique UNIQUE (parcela_id, evento, devedor_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='eventos_webhook_token_unique')
    THEN ALTER TABLE eventos_webhook ADD CONSTRAINT eventos_webhook_token_unique UNIQUE (zapsign_token); END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Índices
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_parcelas_acordo     ON parcelas(acordo_id);
CREATE INDEX IF NOT EXISTS idx_parcelas_vencimento ON parcelas(vencimento);
-- Índice parcial para o cron: filtra candidatas sem carregar parcelas resolvidas
CREATE INDEX IF NOT EXISTS idx_parcelas_cron
  ON parcelas(vencimento)
  WHERE renegociada = false AND tratamento_manual = false;

CREATE INDEX IF NOT EXISTS idx_devedores_email
  ON devedores(email)
  WHERE email IS NOT NULL AND email_valido = true;

CREATE INDEX IF NOT EXISTS idx_acordo_devedores_devedor ON acordo_devedores(devedor_id);
CREATE INDEX IF NOT EXISTS idx_acordo_credoras_credora  ON acordo_credoras(credora_id);
CREATE INDEX IF NOT EXISTS idx_acordo_alunos_aluno      ON acordo_alunos(aluno_id);

CREATE INDEX IF NOT EXISTS idx_lembretes_parcela
  ON lembretes_enviados(parcela_id, evento);
-- Índice parcial para retentativas do cron
CREATE INDEX IF NOT EXISTS idx_lembretes_reprocessar
  ON lembretes_enviados(criado_em)
  WHERE status IN ('pendente', 'falha') AND tentativas < 3;

CREATE INDEX IF NOT EXISTS idx_acordos_cancelado  ON acordos(cancelado)  WHERE cancelado = false;
CREATE INDEX IF NOT EXISTS idx_acordos_criado_por ON acordos(criado_por);

-- ─────────────────────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────────
-- Views derivadas
-- Colunas explícitas (não usa p.* / a.*) para que CREATE OR REPLACE VIEW
-- funcione mesmo quando novas colunas são adicionadas às tabelas base.
-- Novas colunas: acrescentar no final da lista correspondente.
-- ─────────────────────────────────────────────────────────────────────────────

-- DROP antes de CREATE: coluna em ordem diferente em bancos existentes. Transacao garante atomicidade.
DROP VIEW IF EXISTS devedores_sem_email;
DROP VIEW IF EXISTS acordos_com_status;
DROP VIEW IF EXISTS parcelas_com_status;

CREATE VIEW parcelas_com_status AS
SELECT
  p.id, p.acordo_id, p.numero, p.vencimento, p.valor_previsto_cts,
  p.valor_pago_cts, p.data_pagamento, p.referencia_pag, p.observacao,
  p.registrado_por, p.renegociada, p.tratamento_manual, p.tratamento_manual_motivo,
  p.forma_pagamento, p.estornado_em, p.estornado_por, p.motivo_estorno,
  p.classificacao_excedente,
  (p.vencimento - CURRENT_DATE)                                                 AS dias_para_vencimento,
  CASE
    WHEN p.renegociada                                          THEN 'renegociada'
    WHEN p.valor_pago_cts >= p.valor_previsto_cts               THEN 'pago'
    WHEN p.valor_pago_cts IS NOT NULL AND p.valor_pago_cts > 0  THEN 'pago_parcial'
    WHEN p.vencimento < CURRENT_DATE                            THEN 'vencido'
    ELSE                                                             'a_vencer'
  END AS status,
  GREATEST(0, p.valor_previsto_cts - COALESCE(p.valor_pago_cts, 0))             AS saldo_cts,
  GREATEST(0, COALESCE(p.valor_pago_cts, 0) - p.valor_previsto_cts)             AS valor_excedente_cts
FROM parcelas p;

CREATE VIEW acordos_com_status AS
SELECT
  a.id, a.numero, a.cancelado, a.valor_total_cts, a.entrada_cts, a.n_parcelas,
  a.valor_parcela_cts, a.data_primeira_parcela, a.multa_mora_pct, a.juros_pct,
  a.multa_penal_pct, a.honorarios_pct, a.indice_correcao, a.origem_divida,
  a.periodo_referencia, a.foro, a.modo_assinatura, a.zapsign_token,
  a.assinado_em, a.drive_file_id, a.snapshot_assinatura_json, a.lembretes_ativos,
  a.lembretes_desativado_por, a.acordo_pai_id, a.criado_por, a.criado_em,
  a.atualizado_em, a.idempotency_key, a.data_assinatura,
  CASE
    WHEN a.cancelado THEN 'cancelado'
    WHEN NOT EXISTS (
      SELECT 1 FROM parcelas WHERE acordo_id = a.id
    )                THEN 'rascunho'
    WHEN NOT EXISTS (
      SELECT 1 FROM parcelas_com_status pcs
      WHERE pcs.acordo_id = a.id
        AND pcs.status NOT IN ('pago', 'renegociada')
    )                THEN 'quitado'
    WHEN EXISTS (
      SELECT 1 FROM parcelas_com_status pcs
      WHERE pcs.acordo_id = a.id AND pcs.status = 'vencido'
    )                THEN 'inadimplente'
    ELSE                  'ativo'
  END AS status,
  COALESCE((
    SELECT SUM(saldo_cts)
    FROM parcelas_com_status pcs
    WHERE pcs.acordo_id = a.id
      AND pcs.status NOT IN ('pago', 'renegociada')
  ), 0) AS saldo_total_cts,
  (
    SELECT MIN(vencimento)
    FROM parcelas_com_status pcs
    WHERE pcs.acordo_id = a.id AND pcs.status = 'a_vencer'
  ) AS proximo_vencimento
FROM acordos a;

CREATE VIEW devedores_sem_email AS
SELECT
  d.id, d.nome, d.cpf, d.telefone, d.email, d.email_valido,
  COUNT(DISTINCT ad.acordo_id) AS n_acordos_ativos
FROM devedores d
JOIN acordo_devedores ad ON ad.devedor_id = d.id
JOIN acordos_com_status acs ON acs.id = ad.acordo_id
WHERE (d.email IS NULL OR d.email_valido = false)
  AND acs.status IN ('ativo', 'inadimplente')
GROUP BY d.id, d.nome, d.cpf, d.telefone, d.email, d.email_valido;

-- Funções auxiliares
-- Declaradas APÓS as tabelas: LANGUAGE sql valida referências a tabelas em tempo
-- de criação (diferente de plpgsql, que valida na chamada).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_user_id() RETURNS UUID
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

-- SECURITY DEFINER: lê usuarios sem recursão de RLS
CREATE OR REPLACE FUNCTION app_user_ativo() RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios WHERE id = app_user_id() AND ativo = true
  )
$$;

CREATE OR REPLACE FUNCTION app_user_admin() RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios WHERE id = app_user_id() AND papel = 'admin' AND ativo = true
  )
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Autorização
-- ─────────────────────────────────────────────────────────────────────────────
-- RLS não é implementada nesta versão. Motivos:
--
-- 1. DATABASE_URL usa neondb_owner, que tem BYPASSRLS no Neon — as policies
--    seriam ignoradas silenciosamente sem nenhum aviso.
-- 2. Ativar corretamente exigiria um papel app_user (NOBYPASSRLS) separado e
--    duas connection strings — escopo desproporcional para um backend único.
-- 3. A autorização já é feita na camada da aplicação via JWT, coberta por testes.
--
-- Para ativar RLS no futuro: crie o papel app_user, ajuste DATABASE_URL e
-- aplique as policies em db/rls_opcional.sql (a criar quando necessário).
-- As funções app_user_id/app_user_ativo/app_user_admin estão prontas para isso.

-- ── Colunas adicionadas em migrações posteriores (idempotentes) ─────────────
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token          TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token_expira_em TIMESTAMPTZ;

-- Índice parcial para unicidade do aviso interno D+15 (um por parcela, sem data):
-- devedor_id é NULL nos registros internos, então a constraint UNIQUE(parcela_id,evento,devedor_id)
-- não garante unicidade (PostgreSQL trata NULL != NULL). Este índice resolve.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lembretes_interno_unico
  ON lembretes_enviados(parcela_id, canal)
  WHERE canal = 'interno_d15';

COMMIT;
