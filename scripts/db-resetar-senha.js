#!/usr/bin/env node
'use strict';
// Uso: npm run db:resetar-senha
// Atualiza a senha de um usuário existente.

const bcrypt = require('bcryptjs');
const { loadEnv, criarCliente, conectar } = require('./db-utils');

function lerSenha(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    if (!process.stdin.isTTY) {
      const rl = require('readline').createInterface({ input: process.stdin });
      rl.once('line', line => { rl.close(); resolve(line.trim()); });
      return;
    }
    let senha = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    function handler(ch) {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(senha);
      } else if (ch === '\u0003') { process.stdout.write('\n'); process.exit(1); }
      else if (ch === '\u007f') { if (senha.length) { senha = senha.slice(0, -1); process.stdout.write('\b \b'); } }
      else { senha += ch; process.stdout.write('*'); }
    }
    process.stdin.on('data', handler);
  });
}

async function main() {
  loadEnv();
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email) { console.error('\nUso: node scripts/db-resetar-senha.js email@dominio.com\n'); process.exit(1); }

  const client = criarCliente();
  await conectar(client);

  const { rows } = await client.query('SELECT id, nome, papel FROM usuarios WHERE email = $1', [email]);
  if (!rows.length) { await client.end(); console.error(`\nERRO: usuário "${email}" não encontrado.\n`); process.exit(1); }

  const u = rows[0];
  console.log(`\nRedefinindo senha de: ${u.nome} <${email}> (${u.papel})\n`);

  const nova   = await lerSenha('Nova senha (mínimo 8 chars): ');
  if (nova.length < 8) { await client.end(); console.error('\nERRO: senha muito curta.\n'); process.exit(1); }
  const conf   = await lerSenha('Confirme a senha:             ');
  if (nova !== conf)   { await client.end(); console.error('\nERRO: senhas não coincidem.\n'); process.exit(1); }

  process.stdout.write('\nGerando hash...');
  const hash = await bcrypt.hash(nova, 10);
  process.stdout.write(' OK\n');

  await client.query('UPDATE usuarios SET hash_senha = $1 WHERE id = $2', [hash, u.id]);
  await client.end();
  console.log(`\n\x1b[32mSenha atualizada com sucesso para ${email}.\x1b[0m\n`);
}

main().catch(err => { console.error('\nErro:', err.message, '\n'); process.exit(1); });
