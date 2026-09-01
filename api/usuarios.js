'use strict';
// api/usuarios.js — gestão de usuários (somente admin)
//
//   GET    /api/usuarios                      → lista
//   POST   /api/usuarios                      → cria           {nome,email,papel,senha}
//   PATCH  /api/usuarios?id=<uuid>            → altera          {nome?,papel?,ativo?}
//   POST   /api/usuarios?id=<uuid>&acao=senha → define senha    {senha}
//
// Tudo em query string, sem sub-rota: o roteamento por sistema de arquivos do
// Vercel não entrega sub-rotas para um arquivo de API (ver api/_rota.js).
//
// Desativar em vez de excluir: acordos.criado_por referencia usuarios(id), e
// apagar a linha destruiria a autoria dos acordos já emitidos. `ativo=false` é
// verificado a cada requisição por verificarRequisicaoComBanco, então o corte de
// acesso vale na hora, mesmo com JWT ainda dentro da validade de 8h.

const bcrypt = require('bcryptjs');
const { verificarRequisicaoComBanco, applyCors } = require('./_auth');
const { getPool, withTransaction, isDbUnavailable } = require('./_db');

const PAPEIS   = ['secretaria', 'admin'];   // espelha o CHECK do schema
const SENHA_MIN = 8;                        // igual ao confirmar-reset
const CUSTO_BCRYPT = 12;                    // custo documentado no README

const isUUID = s => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const COLUNAS = 'id, nome, email, papel, ativo, criado_em, ultimo_acesso';  // nunca hash_senha

module.exports = async (req, res) => {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── Autenticação e autorização, uma vez, antes de qualquer ramo ────────────
  const user = await verificarRequisicaoComBanco(req, res);
  if (!user) return;
  if (user.papel !== 'admin')
    return res.status(403).json({ erro: 'Apenas administradores podem gerenciar usuários' });

  const id   = (req.query?.id   || '').trim();
  const acao = (req.query?.acao || '').trim();
  if (id && !isUUID(id)) return res.status(400).json({ erro: 'id inválido' });

  try {
    if (req.method === 'GET'   && !id) return await listar(res);
    if (req.method === 'POST'  && !id) return await criar(req, res);
    if (req.method === 'PATCH' &&  id) return await alterar(req, res, id, user);
    if (req.method === 'POST'  &&  id && acao === 'senha') return await definirSenha(req, res, id);

    if (req.method === 'POST' && id)
      return res.status(404).json({ erro: 'Ação desconhecida. Use acao=senha.' });
    if (['GET', 'PATCH'].includes(req.method))
      return res.status(400).json({ erro: req.method === 'GET' ? 'GET não aceita id' : 'PATCH exige id' });
    return res.status(405).json({ erro: 'Método não permitido' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'Já existe usuário com esse e-mail', code: 'EMAIL_DUPLICADO' });
    if (err.code === '23514') return res.status(400).json({ erro: 'Valor rejeitado pelo banco (papel inválido?)' });
    if (err.status)           return res.status(err.status).json({ erro: err.message, code: err.code });
    if (isDbUnavailable(err)) return res.status(503).json({ erro: 'Banco indisponível', code: 'DB_UNAVAILABLE' });
    console.error('[usuarios]', err.message);
    return res.status(500).json({ erro: 'Erro interno' });
  }
};

// ── Validações compartilhadas ────────────────────────────────────────────────
function validarEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  // Suficiente para uso interno; a unicidade real é garantida pelo banco
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    throw Object.assign(new Error('E-mail inválido'), { status: 400 });
  return e;
}
function validarSenha(senha) {
  if (typeof senha !== 'string' || senha.length < SENHA_MIN)
    throw Object.assign(new Error(`Senha deve ter pelo menos ${SENHA_MIN} caracteres`), { status: 400 });
  return senha;
}
function validarPapel(papel) {
  if (!PAPEIS.includes(papel))
    throw Object.assign(new Error(`Papel inválido. Aceito: ${PAPEIS.join(', ')}`), { status: 400 });
  return papel;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/usuarios
// ═══════════════════════════════════════════════════════════════════════════════
async function listar(res) {
  const pool = getPool();
  if (!pool) return res.status(503).json({ erro: 'Banco indisponível' });
  const { rows } = await pool.query(
    `SELECT ${COLUNAS} FROM usuarios ORDER BY ativo DESC, papel, nome`
  );
  return res.status(200).json({ usuarios: rows });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/usuarios — cria
// ═══════════════════════════════════════════════════════════════════════════════
async function criar(req, res) {
  const b = req.body || {};
  const nome = String(b.nome || '').trim();
  if (!nome) throw Object.assign(new Error('Nome obrigatório'), { status: 400 });
  const email = validarEmail(b.email);
  const papel = validarPapel(b.papel || 'secretaria');
  const senha = validarSenha(b.senha);

  const hash = await bcrypt.hash(senha, CUSTO_BCRYPT);
  const pool = getPool();
  if (!pool) return res.status(503).json({ erro: 'Banco indisponível' });

  const { rows } = await pool.query(
    `INSERT INTO usuarios (nome, email, hash_senha, papel, ativo)
     VALUES ($1,$2,$3,$4,true) RETURNING ${COLUNAS}`,
    [nome, email, hash, papel]
  );
  return res.status(201).json(rows[0]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/usuarios?id= — altera nome, papel ou ativo
// ═══════════════════════════════════════════════════════════════════════════════
async function alterar(req, res, id, user) {
  const b = req.body || {};
  const mudaNome  = b.nome  !== undefined;
  const mudaPapel = b.papel !== undefined;
  const mudaAtivo = b.ativo !== undefined;
  if (!mudaNome && !mudaPapel && !mudaAtivo)
    throw Object.assign(new Error('Informe ao menos um campo: nome, papel ou ativo'), { status: 400 });

  const nome  = mudaNome  ? String(b.nome || '').trim() : null;
  if (mudaNome && !nome) throw Object.assign(new Error('Nome não pode ficar vazio'), { status: 400 });
  const papel = mudaPapel ? validarPapel(b.papel) : null;
  if (mudaAtivo && typeof b.ativo !== 'boolean')
    throw Object.assign(new Error('Campo ativo deve ser booleano'), { status: 400 });

  const ehEuMesmo = id === user.sub;
  // Trava de auto-bloqueio: sem isto, um admin consegue se trancar para fora e
  // ninguém mais consegue criar usuários — só sobraria acesso por linha de comando.
  if (ehEuMesmo && mudaAtivo && b.ativo === false)
    throw Object.assign(new Error('Não é possível desativar a própria conta'), { status: 409, code: 'AUTO_BLOQUEIO' });
  if (ehEuMesmo && mudaPapel && papel !== 'admin')
    throw Object.assign(new Error('Não é possível rebaixar a própria conta'), { status: 409, code: 'AUTO_BLOQUEIO' });

  const resultado = await withTransaction(async (db) => {
    const { rows } = await db.query('SELECT id, papel, ativo FROM usuarios WHERE id = $1 FOR UPDATE', [id]);
    const alvo = rows[0];
    if (!alvo) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });

    // Trava do último admin: vale mesmo mexendo em outra conta, porque o alvo
    // pode ser o único admin ativo restante.
    const perdeAdmin = (mudaPapel && alvo.papel === 'admin' && papel !== 'admin')
                    || (mudaAtivo && alvo.papel === 'admin' && b.ativo === false && alvo.ativo);
    if (perdeAdmin) {
      const { rows: c } = await db.query(
        `SELECT COUNT(*)::int n FROM usuarios WHERE papel = 'admin' AND ativo = true AND id <> $1`, [id]
      );
      if (c[0].n === 0)
        throw Object.assign(new Error('Este é o último administrador ativo. Promova outro antes.'),
          { status: 409, code: 'ULTIMO_ADMIN' });
    }

    const campos = [], valores = [];
    if (mudaNome)  { campos.push(`nome  = $${campos.length + 1}`); valores.push(nome); }
    if (mudaPapel) { campos.push(`papel = $${campos.length + 1}`); valores.push(papel); }
    if (mudaAtivo) { campos.push(`ativo = $${campos.length + 1}`); valores.push(b.ativo); }
    valores.push(id);

    const { rows: upd } = await db.query(
      `UPDATE usuarios SET ${campos.join(', ')} WHERE id = $${valores.length} RETURNING ${COLUNAS}`, valores
    );

    // Desativação é registrada: é o mais próximo de uma exclusão que fazemos
    if (mudaAtivo && b.ativo === false)
      await db.query(
        `INSERT INTO auditoria_exclusoes (tabela, registro_id, excluido_por, motivo)
         VALUES ('usuarios', $1, $2, $3)`,
        [id, user.sub, `Desativação por ${user.email || user.sub}`]
      );

    return upd[0];
  });

  return res.status(200).json(resultado);
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/usuarios?id=&acao=senha — admin define nova senha
// ═══════════════════════════════════════════════════════════════════════════════
async function definirSenha(req, res, id) {
  const senha = validarSenha((req.body || {}).senha);
  const hash  = await bcrypt.hash(senha, CUSTO_BCRYPT);

  const pool = getPool();
  if (!pool) return res.status(503).json({ erro: 'Banco indisponível' });

  // Zera qualquer token de recuperação pendente: a senha acabou de mudar
  const { rows } = await pool.query(
    `UPDATE usuarios SET hash_senha = $1, reset_token = NULL, reset_token_expira_em = NULL
     WHERE id = $2 RETURNING ${COLUNAS}`,
    [hash, id]
  );
  if (!rows[0]) return res.status(404).json({ erro: 'Usuário não encontrado' });
  return res.status(200).json({ ok: true, usuario: rows[0] });
}
