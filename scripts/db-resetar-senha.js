#!/usr/bin/env node
'use strict';
// Uso: npm run db:resetar-senha
// Atualiza a senha de um usuário existente.

const bcrypt = require('bcryptjs');
const { loadEnv, criarCliente, conectar } = require('./db-utils');

function lerSenha(prompt) {
  return new Promise((resolve) => {
    // readline simples — sem modo raw, funciona no PowerShell/VS Code
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); });
  });
}

async function main() {
  loadEnv();
  const email = (process.argv[2] || '').trim().toLowerCase();
  const senhaArg = (process.argv[3] || '').trim();
  if (!email) { console.error('\nUso: node scripts/db-resetar-senha.js email@dominio.com NovaSenha\n'); process.exit(1); }

  let nova, conf;
  if (senhaArg) {
    nova = conf = senhaArg; // não-interativo: senha via argumento
  } else {
    console.log(`\nRedefinindo senha de: ${email}\n`);
    nova = await lerSenha('Nova senha (mínimo 8 chars): ');
    conf = await lerSenha('Confirme a senha:             ');
  }

  if (nova.length < 8) { console.error('\nERRO: senha muito curta.\n'); process.exit(1); }
  if (nova !== conf)   { console.error('\nERRO: senhas não coincidem.\n'); process.exit(1); }

  process.stdout.write('Gerando hash e conectando...');
  const hash = await bcrypt.hash(nova, 10);

  const client = criarCliente();
  await conectar(client);

  const { rows } = await client.query(
    'UPDATE usuarios SET hash_senha = $1 WHERE email = $2 RETURNING nome, email, papel',
    [hash, email]
  );
  await client.end();

  if (!rows.length) { console.error(`\nERRO: usuário "${email}" não encontrado.\n`); process.exit(1); }
  console.log(` OK\n\n\x1b[32mSenha atualizada: ${rows[0].nome} <${rows[0].email}>\x1b[0m\n`);
}

main().catch(err => { console.error('\nErro:', err.message, '\n'); process.exit(1); });
