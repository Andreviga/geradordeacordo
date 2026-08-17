'use strict';
// Extração dos segmentos de sub-rota para os handlers de /api/acordos/* e
// /api/parcelas/*.
//
// Por que isto existe: o roteamento por sistema de arquivos do Vercel não
// entrega sub-rotas para `dir/index.js` — comprovado em produção, /api/acordos
// respondia 401 e /api/acordos/<uuid> respondia 404. O vercel.json faz o rewrite
// de `/api/<recurso>/:rota*` para `/api/<recurso>?_rota=:rota*`, e é daí que os
// segmentos são lidos.
//
// Os segmentos vêm em `_seg1`/`_seg2` e não num único parâmetro repetido: o
// path-to-regexp do Vercel recusa `:rota*` dentro da querystring do destino
// ("Can not repeat \"rota\" without a prefix and suffix"). As rotas existentes
// têm no máximo dois segmentos (/:id/cancelar, /:id/baixar), então nomear cada
// um evita o problema de vez.
//
// A leitura tem três fontes, em ordem de confiança:
//   1. `_seg1`/`_seg2` — postos pelo rewrite do vercel.json (produção)
//   2. `params`        — preenchido pelo runtime quando ele mesmo casa a rota
//   3. req.url         — fallback para chamadas diretas (testes, `vercel dev`)
// Assim o mesmo handler roda em produção, em teste e localmente sem ramificação.

function _lista(v) {
  if (Array.isArray(v)) return v.flatMap(s => String(s).split('/')).filter(Boolean);
  if (typeof v === 'string' && v) return v.split('/').filter(Boolean);
  return [];
}

/**
 * @param {object} req      requisição
 * @param {string} recurso  'acordos' | 'parcelas'
 * @returns {string[]} segmentos após /api/<recurso>/
 */
function segmentosDaRota(req, recurso) {
  const q = req.query || {};

  const doRewrite = [..._lista(q._seg1), ..._lista(q._seg2)];
  if (doRewrite.length) return doRewrite;

  const doRuntime = _lista(q.params);
  if (doRuntime.length) return doRuntime;

  const caminho = String(req.url || '').split('?')[0];
  const depois  = caminho.replace(new RegExp(`^/api/${recurso}/?`), '');
  return _lista(depois);
}

module.exports = { segmentosDaRota };
