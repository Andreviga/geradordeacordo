// tests/usuarios.test.js — gestão de usuários contra Postgres real (PGlite)
//
// As travas que importam aqui (último admin, auto-bloqueio) dependem de
// transação e de contagem no banco. Testar isso com mock provaria pouco, então
// o teste roda contra PostgreSQL de verdade, em WASM, dentro do processo.

'use strict';

const fs   = require('fs');
const path = require('path');

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else      { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

const SECRET = 'test-secret-32-chars-xxxxxxxxxxxxxxxxx';
const ADMIN  = '00000000-0000-4000-8000-000000000001';
const SECRE  = '00000000-0000-4000-8000-000000000002';
const ADMIN2 = '00000000-0000-4000-8000-000000000003';

function mockReq(method, query = {}, body = null, token = null) {
  return {
    method, query, body,
    headers: token ? { authorization: 'Bearer ' + token } : {},
    setHeader() {},
  };
}
function mockRes() {
  return {
    _status: null, _body: null,
    status(c) { this._status = c; return this; },
    json(b)   { this._body = b;   return this; },
    end()     { return this; },
    setHeader() { return this; },
  };
}

async function main() {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  await db.waitReady;
  await db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));

  // Substitui o _db pelo PGlite ANTES de carregar o handler, que desestrutura
  // getPool/withTransaction no topo do módulo.
  const caminhoDb = require.resolve('../api/_db');
  require('../api/_db');
  require.cache[caminhoDb].exports = {
    getPool: () => db,
    withTransaction: async (fn) => {
      await db.query('BEGIN');
      try { const r = await fn(db); await db.query('COMMIT'); return r; }
      catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
    },
    isDbUnavailable: () => false,
  };

  process.env.JWT_SECRET = SECRET;
  const { criarJWT } = require('../api/_auth');
  const handler = require('../api/usuarios');

  const agora = Math.floor(Date.now() / 1000);
  const tok = (sub, papel) => criarJWT({ sub, papel, email: sub + '@x.com', iat: agora, exp: agora + 3600 }, SECRET);
  const tokAdmin = tok(ADMIN, 'admin');
  const tokSecre = tok(SECRE, 'secretaria');

  const chamar = async (method, query, body, token) => {
    const res = mockRes();
    await handler(mockReq(method, query, body, token), res);
    return res;
  };

  async function semear() {
    await db.query('TRUNCATE usuarios, auditoria_exclusoes CASCADE');
    await db.query(
      `INSERT INTO usuarios (id,nome,email,hash_senha,papel,ativo) VALUES
         ($1,'Admin Um','admin1@x.com','$2a$10$h','admin',true),
         ($2,'Secretaria','sec@x.com','$2a$10$h','secretaria',true)`, [ADMIN, SECRE]);
  }

  // ── [1] Autorização ────────────────────────────────────────────────────────
  grupo('[1] Só admin gerencia usuários');
  await semear();
  {
    let r = await chamar('GET', {}, null, null);
    assert('sem token → 401', r._status === 401);
    r = await chamar('GET', {}, null, tokSecre);
    assert('secretaria → 403', r._status === 403);
    assert('mensagem cita administradores', /administradores/i.test(JSON.stringify(r._body)));
    r = await chamar('GET', {}, null, tokAdmin);
    assert('admin → 200', r._status === 200);
    assert('lista os 2 usuários', r._body.usuarios.length === 2);
  }

  // ── [2] A senha nunca sai do banco ─────────────────────────────────────────
  grupo('[2] hash_senha nunca é devolvido');
  {
    const r = await chamar('GET', {}, null, tokAdmin);
    const bruto = JSON.stringify(r._body);
    assert('lista não traz hash_senha', !bruto.includes('hash_senha') && !bruto.includes('$2a$'));
    const c = await chamar('POST', {}, { nome: 'Nova', email: 'nova@x.com', senha: 'senha-forte-123', papel: 'secretaria' }, tokAdmin);
    assert('criação → 201', c._status === 201);
    assert('resposta da criação não traz hash', !JSON.stringify(c._body).includes('$2'));
  }

  // ── [3] Validação na criação ───────────────────────────────────────────────
  grupo('[3] Validação de entrada');
  {
    let r = await chamar('POST', {}, { nome: 'X', email: 'nao-e-email', senha: 'senha-forte-123' }, tokAdmin);
    assert('e-mail inválido → 400', r._status === 400);
    r = await chamar('POST', {}, { nome: 'X', email: 'x@y.com', senha: 'curta' }, tokAdmin);
    assert('senha < 8 → 400', r._status === 400);
    r = await chamar('POST', {}, { nome: 'X', email: 'x@y.com', senha: 'senha-forte-123', papel: 'deus' }, tokAdmin);
    assert('papel inválido → 400', r._status === 400);
    r = await chamar('POST', {}, { nome: '', email: 'x@y.com', senha: 'senha-forte-123' }, tokAdmin);
    assert('nome vazio → 400', r._status === 400);
    r = await chamar('POST', {}, { nome: 'Dup', email: 'NOVA@x.com', senha: 'senha-forte-123' }, tokAdmin);
    assert('e-mail duplicado (mesmo com caixa diferente) → 409', r._status === 409);
    assert('code EMAIL_DUPLICADO', r._body.code === 'EMAIL_DUPLICADO');
  }

  // ── [4] Auto-bloqueio ──────────────────────────────────────────────────────
  grupo('[4] Admin não consegue se trancar para fora');
  await semear();
  {
    let r = await chamar('PATCH', { id: ADMIN }, { ativo: false }, tokAdmin);
    assert('desativar a si mesmo → 409', r._status === 409);
    assert('code AUTO_BLOQUEIO', r._body.code === 'AUTO_BLOQUEIO');
    r = await chamar('PATCH', { id: ADMIN }, { papel: 'secretaria' }, tokAdmin);
    assert('rebaixar a si mesmo → 409', r._status === 409);

    const { rows } = await db.query('SELECT ativo, papel FROM usuarios WHERE id = $1', [ADMIN]);
    assert('conta segue ativa e admin no banco', rows[0].ativo === true && rows[0].papel === 'admin');
  }

  // ── [5] Último admin ───────────────────────────────────────────────────────
  grupo('[5] O último admin ativo é protegido');
  await semear();
  {
    // ADMIN é o único admin; promover ADMIN2 e então rebaixar ADMIN2 deve funcionar
    await db.query(`INSERT INTO usuarios (id,nome,email,hash_senha,papel,ativo)
                    VALUES ($1,'Admin Dois','admin2@x.com','$2a$10$h','admin',true)`, [ADMIN2]);
    let r = await chamar('PATCH', { id: ADMIN2 }, { papel: 'secretaria' }, tokAdmin);
    assert('rebaixar admin havendo outro → 200', r._status === 200);
    assert('papel virou secretaria', r._body.papel === 'secretaria');

    // agora ADMIN é o único admin ativo — outro admin tentando desativá-lo falha
    const tok2 = tok(ADMIN2, 'admin');   // token diz admin, mas o banco manda
    r = await chamar('PATCH', { id: ADMIN }, { ativo: false }, tok2);
    assert('desativar o último admin → 403 (quem pede já não é admin no banco)', r._status === 403);

    // com um segundo admin de verdade, desativar o primeiro passa
    await db.query(`UPDATE usuarios SET papel='admin' WHERE id=$1`, [ADMIN2]);
    r = await chamar('PATCH', { id: ADMIN }, { ativo: false }, tok(ADMIN2, 'admin'));
    assert('havendo outro admin ativo, desativar → 200', r._status === 200);
    assert('ficou inativo', r._body.ativo === false);

    // e agora ADMIN2 é o último: não pode se desativar nem ser rebaixado
    r = await chamar('PATCH', { id: ADMIN2 }, { papel: 'secretaria' }, tok(ADMIN2, 'admin'));
    assert('último admin não pode ser rebaixado → 409', r._status === 409);
    assert('code AUTO_BLOQUEIO ou ULTIMO_ADMIN', ['AUTO_BLOQUEIO', 'ULTIMO_ADMIN'].includes(r._body.code));
  }

  // ── [6] Desativação é auditada e corta o acesso ────────────────────────────
  grupo('[6] Desativação registra auditoria');
  await semear();
  {
    await db.query(`INSERT INTO usuarios (id,nome,email,hash_senha,papel,ativo)
                    VALUES ($1,'Admin Dois','admin2@x.com','$2a$10$h','admin',true)`, [ADMIN2]);
    await chamar('PATCH', { id: SECRE }, { ativo: false }, tokAdmin);
    const { rows } = await db.query(
      `SELECT tabela, registro_id, excluido_por FROM auditoria_exclusoes WHERE tabela='usuarios'`);
    assert('gravou linha de auditoria', rows.length === 1);
    assert('aponta o usuário desativado', rows[0].registro_id === SECRE);
    assert('registra quem desativou',     rows[0].excluido_por === ADMIN);

    // usuário desativado perde acesso na hora, mesmo com JWT válido
    const r = await chamar('GET', {}, null, tok(SECRE, 'secretaria'));
    assert('desativado com JWT válido → 401', r._status === 401);
  }

  // ── [7] Definir senha ──────────────────────────────────────────────────────
  grupo('[7] Admin define senha e invalida token de recuperação');
  await semear();
  {
    await db.query(`UPDATE usuarios SET reset_token='abc', reset_token_expira_em=NOW()+interval '1 hour' WHERE id=$1`, [SECRE]);
    let r = await chamar('POST', { id: SECRE, acao: 'senha' }, { senha: 'curta' }, tokAdmin);
    assert('senha curta → 400', r._status === 400);

    r = await chamar('POST', { id: SECRE, acao: 'senha' }, { senha: 'outra-senha-forte' }, tokAdmin);
    assert('senha válida → 200', r._status === 200);

    const { rows } = await db.query('SELECT hash_senha, reset_token FROM usuarios WHERE id=$1', [SECRE]);
    const bcrypt = require('bcryptjs');
    assert('hash confere com a nova senha', await bcrypt.compare('outra-senha-forte', rows[0].hash_senha));
    assert('custo do bcrypt é 12', rows[0].hash_senha.startsWith('$2a$12$') || rows[0].hash_senha.startsWith('$2b$12$'));
    assert('token de recuperação zerado', rows[0].reset_token === null);

    r = await chamar('POST', { id: '00000000-0000-4000-8000-000000000099', acao: 'senha' }, { senha: 'outra-senha-forte' }, tokAdmin);
    assert('usuário inexistente → 404', r._status === 404);
  }

  // ── [8] Roteamento ─────────────────────────────────────────────────────────
  grupo('[8] Método e rota');
  await semear();
  {
    let r = await chamar('OPTIONS', {}, null, null);
    assert('OPTIONS → 204 sem exigir token', r._status === 204);
    r = await chamar('GET', { id: 'nao-e-uuid' }, null, tokAdmin);
    assert('id inválido → 400', r._status === 400);
    r = await chamar('PATCH', {}, { nome: 'X' }, tokAdmin);
    assert('PATCH sem id → 400', r._status === 400);
    r = await chamar('PATCH', { id: ADMIN }, {}, tokAdmin);
    assert('PATCH sem campo nenhum → 400', r._status === 400);
    r = await chamar('POST', { id: ADMIN, acao: 'inventada' }, {}, tokAdmin);
    assert('ação desconhecida → 404', r._status === 404);
    r = await chamar('DELETE', {}, null, tokAdmin);
    assert('DELETE → 405', r._status === 405);
  }

  await db.close();
  console.log(`\nResultado: ${passou} ✓  ${falhou} ✗`);
  if (falhou > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
