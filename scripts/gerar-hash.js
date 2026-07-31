#!/usr/bin/env node
// scripts/gerar-hash.js — gera o hash bcrypt da senha para APP_PASSWORD_HASH
//
// Uso:  npm run hash
//   ou  node scripts/gerar-hash.js
//
// Cole o hash gerado em: Vercel → projeto → Settings → Environment Variables
// como valor de APP_PASSWORD_HASH.
//
// ⚠  Feche este terminal após copiar para limpar o histórico de comandos.

'use strict';

let bcrypt;
try {
  bcrypt = require('bcryptjs');
} catch {
  console.error(
    'Erro: bcryptjs não instalado. Execute primeiro:\n' +
    '  npm install\n'
  );
  process.exit(1);
}

function lerSenhaOculta(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);

    if (process.stdin.isTTY) {
      // Terminal interativo: lê caractere por caractere com mascaramento
      const chars = [];
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      function onData(ch) {
        if (ch === '\r' || ch === '\n') {
          cleanup(); process.stdout.write('\n'); resolve(chars.join(''));
        } else if (ch === '\u0003') {
          cleanup(); process.stdout.write('\n'); process.exit(0);
        } else if (ch === '\u007F' || ch === '\b') {
          if (chars.length > 0) { chars.pop(); process.stdout.write('\b \b'); }
        } else if (ch.charCodeAt(0) >= 32) {
          chars.push(ch); process.stdout.write('*');
        }
      }
      function cleanup() {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      process.stdin.on('data', onData);
    } else {
      // Entrada redirecionada (pipe): lê linha completa via readline
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      let done = false;
      rl.once('line', line => { done = true; rl.close(); resolve(line.trim()); });
      rl.once('close', () => { if (!done) resolve(''); });
    }
  });
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Gerador de hash bcrypt para APP_PASSWORD_HASH');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const senha = await lerSenhaOculta('Senha: ');

  if (!senha.trim()) {
    console.error('\nErro: senha não pode ser vazia.');
    process.exit(1);
  }
  if (senha.length < 8) {
    console.error('\nErro: use ao menos 8 caracteres.');
    process.exit(1);
  }

  console.log('\nGerando hash bcrypt (custo 12)…');
  const hash = await bcrypt.hash(senha, 12);

  console.log('\n─── Cole em APP_PASSWORD_HASH ───────────────────────────────────');
  console.log(hash);
  console.log('─────────────────────────────────────────────────────────────────');
  console.log('\nPassos:');
  console.log('  1. Vercel → projeto → Settings → Environment Variables');
  console.log('  2. Crie (ou atualize) APP_PASSWORD_HASH com o valor acima');
  console.log('  3. Redeploy para as variáveis entrarem em vigor');
}

main().catch(err => {
  console.error('\nErro inesperado:', err.message);
  process.exit(1);
});
