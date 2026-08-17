'use strict';
// Única função serverless de /api/parcelas/* — atende a raiz e as sub-rotas.
//
// Antes desta correção, TODAS as rotas /api/parcelas/* respondiam 404 em produção
// e os botões de baixa e estorno da tela "Parcelas vencidas" não funcionavam.
// Causa: a pasta só tinha `[[...params]].js`, e o Vercel não roteia catch-all
// opcional fora do Next.js. Confirmado em produção:
//   OPTIONS /api/parcelas/<uuid>/baixar → 404   (só tinha o catch-all)
//   OPTIONS /api/acordos                → 204   (tinha este mesmo wrapper)
//
// A lógica mora em _handler.js: além de não rotear, cada .js em api/ conta no
// limite de 12 funções do plano Hobby — o catch-all gastava uma vaga sem atender
// requisição nenhuma. O prefixo `_` faz dele módulo privado, carregado por require.
//
// As sub-rotas (/api/parcelas/<uuid>/baixar e /estornar) chegam aqui por rewrite
// declarado no vercel.json — o roteamento por sistema de arquivos NÃO as entrega
// sozinho. Este wrapper injeta os segmentos em req.query.params antes de delegar.
// A autenticação é verificada dentro do _handler.js.
const { segmentosDaRota } = require('../_rota');
const handler = require('./_handler');
module.exports = (req, res) => {
  req.query = req.query || {};
  req.query.params = segmentosDaRota(req, 'parcelas');
  return handler(req, res);
};
