#!/usr/bin/env node
'use strict';
// scripts/db-criar-admin.js — cria o primeiro usuário administrador
// Uso: npm run db:criar-admin

const readline = require('readline');
const bcrypt   = require('bcryptjs');
const { loadEnv, criarCliente, conectar } = require('./db-utils');

// Lê uma linha normal do terminal
function lerLinha(rl, pergunta) {
  return new Promise(resolve => rl.question(pergunta, ans => resolve(ans.trim())));
}

// Lê senha com máscara de asteriscos (sem eco no terminal)
function lerSenha(pergunta) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Em pipe/CI, lê sem máscara
      const rl = readline.createInterface({ input: process.stdin });
      process.stdout.write(pergunta);
      rl.once('line', line => { rl.close(); resolve(line.trim()); });
      return;
    }
    process.stdout.write(pergunta);
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
      } else if (ch === '\u0003') {       // Ctrl+C
        process.stdout.write('\n');
        process.exit(1);
      } else if (ch === '\u007f') {       // Backspace
        if (senha.length > 0) {
          senha = senha.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        senha += ch;
        process.stdout.write('*');
      }
    }
    process.stdin.on('data', handler);
  });
}

async function main() {
  loadEnv();

  console.log('\ndb:criar-admin — criação de usuário administrador\n' + '─'.repeat(49));

  // ── Pré-verificação: banco acessível e schema aplicado ───────────────────
  let client;
  try { client = criarCliente(); }
  catch (err) { sair(err.message); }
  try { await conectar(client); }
  catch (err) { sair(err.message); }

  const { rows: tbl } = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='usuarios'`
  );
  if (tbl.length === 0) {
    await client.end();
    sair('Tabela "usuarios" não encontrada.\n  Execute npm run db:migrate antes de criar usuários.');
  }
  // Mantém a conexão aberta durante o input (timeout Neon > 5min, input < 1min)

  console.log('Banco verificado. Informe os dados do administrador.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let nome, email, senha;
  try {
    nome = await lerLinha(rl, 'Nome completo: ');
    if (!nome) throw new Error('Nome é obrigatório.');

    email = (await lerLinha(rl, 'E-mail (será o login): ')).toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new Error('E-mail inválido. Use o formato usuario@dominio.com.');

    rl.close();

    senha = await lerSenha('Senha (mínimo 8 caracteres): ');
    if (senha.length < 8) throw new Error('Senha deve ter pelo menos 8 caracteres.');

    const confirma = await lerSenha('Confirme a senha: ');
    if (senha !== confirma) throw new Error('As senhas não coincidem.');
  } catch (err) {
    try { rl.close(); } catch (_) {}
    await client.end();
    sair(err.message);
  }

  // Confirmar antes de conectar
  console.log(`\nResumo:`);
  console.log(`  Nome:  ${nome}`);
  console.log(`  Email: ${email}`);
  console.log(`  Papel: admin`);

  const rlConf = readline.createInterface({ input: process.stdin, output: process.stdout });
  const conf = await lerLinha(rlConf, '\nConfirmar? [s/N] ');
  rlConf.close();
  if (conf.toLowerCase() !== 's') {
    console.log('\nCancelado.\n');
    await client.end();
    process.exit(0);
  }

  // client já está conectado (aberto na pré-verificação)

  // Verificar se e-mail já existe
  const { rows } = await client.query(
    'SELECT papel FROM usuarios WHERE email = $1', [email]
  );
  if (rows.length > 0) {
    await client.end();
    sair(`Já existe um usuário com o e-mail "${email}" (papel: ${rows[0].papel}).\nUse outro e-mail ou contate o administrador do sistema.`);
  }

  // Gerar hash (custo 10 = ~100ms; suficiente para uso interno)
  process.stdout.write('\nGerando hash da senha...');
  const hash = await bcrypt.hash(senha, 10);
  process.stdout.write(' OK\n');

  await client.query(
    `INSERT INTO usuarios (nome, email, hash_senha, papel) VALUES ($1, $2, $3, 'admin')`,
    [nome, email, hash]
  );

  await client.end();
  console.log(`\n\x1b[32mAdministrador criado com sucesso.\x1b[0m`);
  console.log(`  Nome:  ${nome}`);
  console.log(`  Email: ${email}`);
  console.log(`  Papel: admin\n`);
  console.log('Próximo passo: npm run db:status  (para confirmar que tudo está OK)\n');
}

function sair(msg) {
  console.error(`\n\x1b[31mERRO:\x1b[0m ${msg}\n`);
  process.exit(1);
}

main().catch(err => sair(`Erro inesperado: ${err.message}`));
