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
// As sub-rotas (/api/acordos/<uuid>, /api/acordos/<uuid>/cancelar) chegam aqui
// por rewrite declarado no vercel.json — o roteamento por sistema de arquivos NÃO
// as entrega sozinho (comprovado em produção: raiz 401, sub-rota 404).
// Este wrapper injeta os segmentos em req.query.params antes de delegar.
// A autenticação é verificada dentro do _handler.js.
const { segmentosDaRota } = require('../_rota');
const handler = require('./_handler');
module.exports = (req, res) => {
  req.query = req.query || {};
  req.query.params = segmentosDaRota(req, 'acordos');
  return handler(req, res);
};
