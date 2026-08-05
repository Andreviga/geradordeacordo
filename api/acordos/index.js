'use strict';
// Por que este arquivo existe:
//   No Vercel Hobby, quando há um index.js num diretório ao lado de [[...params]].js,
//   req.query.params NÃO é preenchido para sub-rotas (ex: /api/acordos/uuid).
//   Este wrapper extrai os segmentos do req.url e os injeta como req.query.params
//   antes de delegar ao handler do catch-all.
//
// Para remover este arquivo com segurança:
//   1. Verificar se Vercel (ou uma versão futura do runtime) passou a preencher
//      req.query.params corretamente para [[...params]] em diretórios com index.js.
//   2. Testar GET /api/acordos/uuid e confirmar que retorna o acordo (e não a lista).
//   3. Se funcionar, excluir este arquivo e remover o fallback de URL no [[...params]].js.
const handler = require('./[[...params]]');
module.exports = (req, res) => {
  const path = (req.url || '').split('?')[0];
  const after = path.replace(/^\/api\/acordos\/?/, '');
  req.query = req.query || {};
  req.query.params = after ? after.split('/').filter(Boolean) : [];
  return handler(req, res);
};
