'use strict';
// Por que este arquivo existe:
//   O Vercel NÃO roteia `[[...params]].js` fora do Next.js — catch-all opcional é
//   convenção do Next, não do roteamento por sistema de arquivos de /api. Sem um
//   index.js na pasta, TODAS as rotas /api/parcelas/* respondiam 404 em produção
//   (confirmado: OPTIONS /api/parcelas/<uuid>/baixar → 404, enquanto
//   OPTIONS /api/acordos → 204, pasta que já tinha o wrapper).
//   Efeito prático: os botões de baixa e estorno da tela "Parcelas vencidas"
//   ([index.html] → /api/parcelas/:id/baixar e /estornar) não funcionavam.
//
//   Este wrapper extrai os segmentos do req.url e os injeta como req.query.params
//   antes de delegar ao handler do catch-all — mesmo padrão de api/acordos/index.js.
//
// Para remover este arquivo com segurança:
//   1. Confirmar que o runtime do Vercel passou a rotear [[...params]] em /api.
//   2. Testar POST /api/parcelas/<uuid>/baixar e confirmar que não retorna 404.
const handler = require('./[[...params]]');
module.exports = (req, res) => {
  const path  = (req.url || '').split('?')[0];
  const after = path.replace(/^\/api\/parcelas\/?/, '');
  req.query = req.query || {};
  req.query.params = after ? after.split('/').filter(Boolean) : [];
  return handler(req, res);
};
