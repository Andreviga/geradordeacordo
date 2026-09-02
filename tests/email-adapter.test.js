// tests/email-adapter.test.js — o adaptador entrega ao nodemailer tudo o que recebe.
//
// Por que existe: o backup por e-mail chegou SEM O ANEXO, e tudo logava sucesso
// — "[backup] e-mail enviado (1308 bytes)". O parâmetro `attachments` era
// desestruturado na assinatura de send() e simplesmente não repassado ao
// sendMail. Some em silêncio: nodemailer não reclama de um campo que não recebeu,
// e o remetente não tem como saber.
//
// O teste do backup não pegava porque dubla o _emailAdapter inteiro — o
// _email_gmail.js real nunca era exercitado. Aqui o mock desce um nível: o
// nodemailer é dublado, e o adaptador roda de verdade.

'use strict';

let passou = 0, falhou = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  ✓ ${desc}`); passou++; }
  else      { console.error(`  ✗ ${desc}`); falhou++; }
}
function grupo(t) { console.log('\n' + t); }

// Dubla o nodemailer antes de carregar o adaptador, e captura o que chega
const caminhoNM = require.resolve('nodemailer');
require('nodemailer');
let enviado = null;
require.cache[caminhoNM].exports = {
  createTransport: () => ({
    sendMail: async (opcoes) => { enviado = opcoes; return { messageId: 'id-de-teste' }; },
    verify:   async () => true,
  }),
};

process.env.SMTP_USER = 'remetente@exemplo.invalido';
process.env.SMTP_PASS = 'senha-fake';
process.env.EMAIL_FROM = 'Gerador <naoresponda@exemplo.invalido>';

const gmail = require('../api/cron/_email_gmail');

async function main() {
  grupo('[1] O anexo chega ao nodemailer');
  {
    const conteudo = Buffer.from('conteudo-cifrado-do-backup');
    await gmail.send({
      to: 'secretaria@exemplo.invalido',
      subject: 'Backup',
      text: 'corpo',
      attachments: [{ filename: 'backup.json.gz.enc', content: conteudo }],
    });

    assert('sendMail foi chamado', enviado !== null);
    assert('attachments foi repassado — era exatamente isto que faltava',
      Array.isArray(enviado.attachments) && enviado.attachments.length === 1);
    assert('o nome do arquivo chega intacto',
      enviado.attachments && enviado.attachments[0].filename === 'backup.json.gz.enc');
    assert('o conteúdo do anexo chega byte a byte',
      enviado.attachments && Buffer.isBuffer(enviado.attachments[0].content)
      && enviado.attachments[0].content.equals(conteudo));
  }

  grupo('[2] Sem anexo, a mensagem sai limpa');
  {
    enviado = null;
    await gmail.send({ to: 'x@y.com', subject: 'Lembrete', text: 'corpo' });
    assert('não inventa campo attachments quando não há anexo',
      !('attachments' in enviado));
    assert('lembretes seguem funcionando', enviado.to === 'x@y.com' && enviado.text === 'corpo');
  }

  grupo('[3] Nenhum outro campo se perde no caminho');
  {
    enviado = null;
    await gmail.send({
      to: 'destino@y.com', subject: 'Assunto', text: 'texto',
      html: '<b>html</b>', replyTo: 'responder@y.com',
      attachments: [{ filename: 'a.txt', content: Buffer.from('x') }],
    });
    // Um por um: qualquer campo esquecido na passagem some sem erro
    for (const [campo, esperado] of [
      ['to', 'destino@y.com'], ['subject', 'Assunto'], ['text', 'texto'],
      ['html', '<b>html</b>'], ['replyTo', 'responder@y.com'],
    ]) assert(`${campo} chega ao nodemailer`, enviado[campo] === esperado);

    assert('from vem de EMAIL_FROM', enviado.from === process.env.EMAIL_FROM);
    assert('anexo junto com html também passa', enviado.attachments.length === 1);
  }

  grupo('[4] replyTo cai no remetente quando não informado');
  {
    enviado = null;
    await gmail.send({ to: 'x@y.com', subject: 's', text: 't' });
    assert('replyTo assume o from', enviado.replyTo === process.env.EMAIL_FROM);
  }

  console.log(`\nResultado: ${passou} ✓  ${falhou} ✗`);
  if (falhou > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
