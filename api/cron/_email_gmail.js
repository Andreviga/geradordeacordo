'use strict';
/**
 * Adapter de e-mail para lembretes — Fase E, Etapa 5.
 *
 * Interface: send({ to, subject, text, html, replyTo })
 *            Retorna Promise<{ messageId: string }> ou lança erro.
 *
 * Implementação atual: Gmail via SMTP (porta 587, STARTTLS).
 * Trocar de provedor = criar novo arquivo + apontar a exportação abaixo.
 *
 * Limite Gmail conta gratuita: ~500 e-mails/dia.
 * Volume esperado: ~40/mês → margem confortável.
 * Se o limite for excedido, nodemailer lança erro com código EENVELOPE ou
 * mensagem "Daily user sending limit exceeded" — tratado com status='falha'
 * e retentativa automática pelo cron (tentativas < 3).
 */

const nodemailer = require('nodemailer');

let _transporter = null;

function _getTransporter() {
  if (_transporter) return _transporter;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) throw new Error('SMTP_USER e SMTP_PASS são obrigatórios');
  _transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,        // STARTTLS (upgrade na conexão)
    auth: { user, pass }, // senha de app do Google, não a senha da conta
    // Envio em série evita picos que acionam filtros anti-spam do Gmail
    pool: false,
  });
  return _transporter;
}

/**
 * @param {{ to: string, subject: string, text: string, html?: string, replyTo?: string }} opts
 * @returns {Promise<{ messageId: string }>}
 */
async function send({ to, subject, text, html, replyTo }) {
  const from  = process.env.EMAIL_FROM || process.env.SMTP_USER;
  const reply = replyTo || from;
  const info  = await _getTransporter().sendMail({
    from,
    to,
    replyTo: reply,
    subject,
    text,
    html,
  });
  return { messageId: info.messageId };
}

/** Testar conexão SMTP na inicialização (opcional, usar em scripts manuais). */
async function verificar() {
  await _getTransporter().verify();
}

module.exports = { send, verificar };
