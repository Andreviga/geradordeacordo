'use strict';
/**
 * Factory de adapter de e-mail.
 * Seleciona a implementação via EMAIL_PROVIDER (padrão: 'gmail').
 *
 * Para trocar de provedor: defina EMAIL_PROVIDER=<nome> no Vercel e crie
 * api/cron/_email_<nome>.js com a mesma interface { send, verificar }.
 *
 * Interface exportada:
 *   send({ to, subject, text, html?, replyTo? }) → Promise<{ messageId }>
 *   verificar()                                  → Promise<void>
 */
const provider = process.env.EMAIL_PROVIDER || 'gmail';
module.exports = require(`./_email_${provider}`);
