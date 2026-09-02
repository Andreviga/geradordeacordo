// tests/backup-email.test.js — backup por e-mail: cifra, envio e volta.
//
// O destino do backup passou a ser o e-mail porque service account não tem cota
// de armazenamento e o colégio não tem Drive Compartilhado. O anexo leva a base
// inteira, então vai cifrado.
//
// O que precisa estar provado aqui é o fim da linha: o arquivo que chega no
// e-mail volta para dentro do banco. Cifra que não decifra é perda total, e a
// descoberta seria no pior momento possível.

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else      { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

const SENHA = 'senha-de-teste-do-backup';
const USER  = '00000000-0000-4000-8000-000000000001';

async function main() {
  const cripto = require('../api/cron/_backup_cripto');

  // ── [1] Cifra ────────────────────────────────────────────────────────────
  grupo('[1] Cifra AES-256-GCM');
  {
    const claro = Buffer.from('base com CPF 111.444.777-35 e endereço');
    const c = cripto.cifrar(claro, SENHA);

    assert('detecta arquivo cifrado',        cripto.estaCifrado(c) === true);
    assert('não confunde arquivo em claro',  cripto.estaCifrado(claro) === false);
    assert('ida e volta devolve o original', cripto.decifrar(c, SENHA).equals(claro));
    assert('o conteúdo não aparece em claro no cifrado',
      !c.toString('binary').includes('111.444.777-35'));

    let recusou = false;
    try { cripto.decifrar(c, 'senha-errada'); } catch { recusou = true; }
    assert('senha errada é recusada', recusou);

    const adulterado = Buffer.from(c);
    adulterado[adulterado.length - 1] ^= 1;
    let detectou = false;
    try { cripto.decifrar(adulterado, SENHA); } catch { detectou = true; }
    assert('adulteração de 1 bit é detectada (GCM autentica)', detectou);

    assert('sal aleatório: cifrar duas vezes dá bytes diferentes',
      !cripto.cifrar(claro, SENHA).equals(cripto.cifrar(claro, SENHA)));

    let semSenha = false;
    try { cripto.cifrar(claro, ''); } catch { semSenha = true; }
    assert('cifrar sem senha é recusado', semSenha);
  }

  // ── [2] O envio exige senha ──────────────────────────────────────────────
  grupo('[2] Nunca envia a base em claro');
  {
    const { enviarPorEmail } = require('../api/cron/_backup_engine');
    const antes = process.env.BACKUP_SENHA;
    delete process.env.BACKUP_SENHA;
    process.env.BACKUP_EMAIL = 'secretaria@exemplo.invalido';

    let erro = null;
    try { await enviarPorEmail(Buffer.from('x'), 'b.json.gz', 1); } catch (e) { erro = e; }
    assert('sem BACKUP_SENHA o envio é recusado', erro !== null);
    assert('o erro explica por que, não só o quê',
      erro && /dados de menores|cifrado/i.test(erro.message));
    if (antes !== undefined) process.env.BACKUP_SENHA = antes;
  }

  // ── [3] Destino não configurado ──────────────────────────────────────────
  grupo('[3] Backup sem destino falha alto, não em silêncio');
  {
    const { executarBackup } = require('../api/cron/_backup_engine');
    const guardado = {
      email: process.env.BACKUP_EMAIL, pasta: process.env.DRIVE_BACKUP_FOLDER_ID,
      sa: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    };
    delete process.env.BACKUP_EMAIL;
    delete process.env.DRIVE_BACKUP_FOLDER_ID;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    let erro = null;
    try { await executarBackup({ query: async () => ({ rows: [] }) }); } catch (e) { erro = e; }
    assert('sem Drive e sem e-mail, lança', erro !== null);
    assert('o erro diz quais variáveis resolvem',
      erro && /DRIVE_BACKUP_FOLDER_ID/.test(erro.message) && /BACKUP_EMAIL/.test(erro.message));

    for (const [k, v] of Object.entries({
      BACKUP_EMAIL: guardado.email, DRIVE_BACKUP_FOLDER_ID: guardado.pasta,
      GOOGLE_SERVICE_ACCOUNT_JSON: guardado.sa,
    })) if (v !== undefined) process.env[k] = v;
  }

  // ── [4] Ida e volta completa, contra Postgres real ───────────────────────
  grupo('[4] O anexo do e-mail volta para dentro do banco');
  {
    const { PGlite } = require('@electric-sql/pglite');
    const db = new PGlite();
    await db.waitReady;
    await db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));

    await db.query(`INSERT INTO usuarios (id,nome,email,hash_senha,papel,ativo)
                    VALUES ($1,'Fulano de Tal','f@x.com','$2a$10$h','admin',true)`, [USER]);
    await db.query(`INSERT INTO devedores (id,nome,cpf,end_logradouro)
                    VALUES ('00000000-0000-4000-8000-000000000002','Devedor Ação','11144477735','Rua Um')`);

    // Captura o que o adaptador de e-mail receberia, sem enviar nada
    const caminhoAdapter = require.resolve('../api/cron/_emailAdapter');
    require('../api/cron/_emailAdapter');
    let enviado = null;
    require.cache[caminhoAdapter].exports = {
      send: async (msg) => { enviado = msg; return { messageId: 'fake' }; },
      verificar: async () => {},
    };

    process.env.BACKUP_EMAIL = 'secretaria@exemplo.invalido';
    process.env.BACKUP_SENHA = SENHA;
    delete process.env.DRIVE_BACKUP_FOLDER_ID;   // só e-mail neste teste

    const { executarBackup } = require('../api/cron/_backup_engine');
    const r = await executarBackup(db);
    assert('backup concluiu', r.ok === true);
    assert('registrou o destino e-mail', r.uploads.some(u => u.tipo === 'email'));
    assert('e-mail foi montado', enviado !== null);
    assert('foi para o endereço configurado', enviado.to === 'secretaria@exemplo.invalido');
    assert('tem exatamente um anexo', enviado.attachments && enviado.attachments.length === 1);
    assert('o anexo termina em .enc', /\.enc$/.test(enviado.attachments[0].filename));

    const anexo = enviado.attachments[0].content;
    assert('o anexo está cifrado', cripto.estaCifrado(anexo));
    assert('nenhum CPF aparece em claro no anexo',
      !anexo.toString('binary').includes('11144477735'));
    assert('o corpo do e-mail ensina a restaurar', /db:restore/.test(enviado.text));

    // Agora o que importa: salvar como quem baixa do e-mail, e restaurar
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkp-email-'));
    const arq = path.join(dir, enviado.attachments[0].filename);
    fs.writeFileSync(arq, anexo);

    const { lerDump, conferirSchema, executarRestore, ordemDeRestauracao } = require('../scripts/db-restore');
    const { TABELAS } = require('../api/cron/_backup_engine');

    const lido = lerDump(arq, SENHA);
    assert('o arquivo salvo é reconhecido como cifrado', lido.cifrado === true);
    assert('decifrou e descomprimiu até o JSON', Array.isArray(lido.dump.dados.usuarios));

    // Destrói e restaura a partir do anexo
    await db.query('TRUNCATE usuarios, devedores CASCADE');
    const { rows: vazio } = await db.query('SELECT COUNT(*)::int n FROM devedores');
    assert('banco esvaziado antes do restore', vazio[0].n === 0);

    const ordem = ordemDeRestauracao(lido.dump, TABELAS);
    const { problemas } = await conferirSchema(db, ordem, lido.dump);
    assert('schema compatível', problemas.length === 0);
    const res = await executarRestore(db, ordem, lido.dump, {});
    assert('restore commitou', res.commitado === true);

    const { rows: dev } = await db.query('SELECT nome, cpf FROM devedores');
    assert('devedor voltou com acentuação intacta', dev[0] && dev[0].nome === 'Devedor Ação');
    assert('CPF voltou correto', dev[0] && dev[0].cpf === '11144477735');
    const { rows: usr } = await db.query('SELECT nome FROM usuarios');
    assert('usuário voltou', usr[0] && usr[0].nome === 'Fulano de Tal');

    fs.rmSync(dir, { recursive: true, force: true });
    await db.close();
  }

  // ── [5] Um destino que falha não anula o que deu certo ───────────────────
  grupo('[5] Destinos são independentes');
  {
    const { executarBackup } = require('../api/cron/_backup_engine');
    const poolFake = { query: async () => ({ rows: [] }) };

    // Chave inválida: obterToken falha ao assinar, sem precisar de rede
    const saQuebrada = JSON.stringify({
      client_email: 'x@y.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nnao-e-uma-chave\n-----END PRIVATE KEY-----\n',
    });

    const caminhoAdapter = require.resolve('../api/cron/_emailAdapter');
    let enviou = 0;
    require.cache[caminhoAdapter].exports = {
      send: async () => { enviou++; return { messageId: 'fake' }; },
      verificar: async () => {},
    };

    process.env.BACKUP_EMAIL = 'secretaria@exemplo.invalido';
    process.env.BACKUP_SENHA = SENHA;
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = saQuebrada;
    process.env.DRIVE_BACKUP_FOLDER_ID = 'pasta-qualquer';

    const r = await executarBackup(poolFake);
    assert('e-mail deu certo, Drive falhou → não lança', r.ok === true);
    assert('o e-mail foi enviado uma vez', enviou === 1);
    assert('o sucesso do e-mail é registrado', r.uploads.some(u => u.tipo === 'email'));
    assert('a falha do Drive é registrada, não engolida',
      r.falhas && r.falhas.length === 1 && r.falhas[0].destino === 'drive');

    // Agora os dois falham: aí sim é erro, porque não existe cópia nenhuma
    delete process.env.BACKUP_SENHA;   // derruba o e-mail
    let erro = null;
    try { await executarBackup(poolFake); } catch (e) { erro = e; }
    assert('nenhum destino funcionando → lança', erro !== null);
    assert('o erro diz que nada foi salvo', erro && /nenhum destino/i.test(erro.message));
    assert('o erro lista as duas causas', erro && erro.falhas && erro.falhas.length === 2);

    process.env.BACKUP_SENHA = SENHA;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.DRIVE_BACKUP_FOLDER_ID;
  }

  console.log(`\nResultado: ${passou} ✓  ${falhou} ✗`);
  if (falhou > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
