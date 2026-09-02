'use strict';
// api/cron/_backup_cripto.js — cifra do backup para envio por e-mail.
//
// Por que existe: sem Drive Compartilhado, o destino do backup passou a ser o
// e-mail. O arquivo contém a base inteira — CPF, RG, endereço, telefone de
// responsáveis e nome de menores. Mandar isso em claro, toda semana, para uma
// caixa de e-mail seria trocar um problema (não ter backup) por outro pior
// (vazar a base se a caixa for comprometida).
//
// AES-256-GCM: cifra e autentica. Adulteração é detectada na hora de decifrar,
// não passa como lixo. A chave vem de scrypt sobre BACKUP_SENHA, com sal
// aleatório por arquivo — dois backups da mesma base não produzem o mesmo byte.
//
// Formato do arquivo:
//   'GACRIPT1' (8 bytes) | sal (16) | iv (12) | tag (16) | conteúdo cifrado
//
// ⚠️ Sem a senha não há recuperação. Não existe porta dos fundos — é o ponto de
// cifrar. Guarde BACKUP_SENHA fora do Vercel também: se perder o painel e a
// senha juntos, o backup vira lixo.

const crypto = require('crypto');

const MAGICA   = Buffer.from('GACRIPT1', 'utf8');
const TAM_SAL  = 16;
const TAM_IV   = 12;
const TAM_TAG  = 16;
// N=2^15 equilibra custo e segurança para rodar dentro do limite de uma função
// serverless; leva ~100ms, o que é irrelevante num backup semanal.
const SCRYPT   = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derivarChave(senha, sal) {
  return crypto.scryptSync(Buffer.from(String(senha), 'utf8'), sal, 32, SCRYPT);
}

/** @returns {Buffer} arquivo cifrado, pronto para anexar */
function cifrar(buf, senha) {
  if (!senha) throw new Error('Senha obrigatória para cifrar o backup');
  const sal   = crypto.randomBytes(TAM_SAL);
  const iv    = crypto.randomBytes(TAM_IV);
  const chave = derivarChave(senha, sal);
  const c     = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const dados = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGICA, sal, iv, c.getAuthTag(), dados]);
}

/** O arquivo começa com a assinatura desta cifra? */
function estaCifrado(buf) {
  return Buffer.isBuffer(buf) && buf.length > MAGICA.length && buf.subarray(0, MAGICA.length).equals(MAGICA);
}

/** @returns {Buffer} conteúdo original; lança se a senha estiver errada */
function decifrar(buf, senha) {
  if (!estaCifrado(buf)) throw new Error('Arquivo não está cifrado por este sistema');
  if (!senha) throw new Error('Senha obrigatória para decifrar o backup');
  let p     = MAGICA.length;
  const sal = buf.subarray(p, p += TAM_SAL);
  const iv  = buf.subarray(p, p += TAM_IV);
  const tag = buf.subarray(p, p += TAM_TAG);
  const d   = crypto.createDecipheriv('aes-256-gcm', derivarChave(senha, sal), iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(buf.subarray(p)), d.final()]);
  } catch {
    // GCM não distingue senha errada de arquivo corrompido: os dois falham na
    // verificação do tag. Dizer as duas possibilidades evita caça ao fantasma.
    throw new Error('Não foi possível decifrar: senha incorreta ou arquivo corrompido');
  }
}

module.exports = { cifrar, decifrar, estaCifrado, MAGICA };
