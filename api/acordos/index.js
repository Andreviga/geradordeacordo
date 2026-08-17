'use strict';
// Única função serverless de /api/acordos/* — atende a raiz e as sub-rotas.
//
// Por que a lógica mora em _handler.js e não num arquivo de rota próprio:
//   1. O Vercel NÃO roteia `[[...params]].js` fora do Next.js — catch-all opcional
//      é convenção do Next, não do roteamento por sistema de arquivos de /api.
//      Comprovado: /api/parcelas/* respondia 404 enquanto a pasta só tinha o
//      catch-all, e /api/acordos/* funcionava porque tinha este index.js.
//   2. Mesmo sem rotear, cada .js em api/ conta no limite de 12 funções do plano
//      Hobby — o catch-all gastava uma vaga sem atender uma requisição sequer.
//   Daí o prefixo `_`: módulo privado, não vira função, e é carregado por require.
//
// Este wrapper extrai os segmentos do req.url e os injeta como req.query.params
// antes de delegar. A autenticação é verificada dentro do _handler.js.
const handler = require('./_handler');
module.exports = (req, res) => {
  const path = (req.url || '').split('?')[0];
  const after = path.replace(/^\/api\/acordos\/?/, '');
  req.query = req.query || {};
  req.query.params = after ? after.split('/').filter(Boolean) : [];
  return handler(req, res);
};
