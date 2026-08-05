'use strict';
// Roteia /api/acordos e /api/acordos/* para o handler catch-all,
// extraindo os segmentos do path como req.query.params
const handler = require('./[[...params]]');
module.exports = (req, res) => {
  const path = (req.url || '').split('?')[0];
  const after = path.replace(/^\/api\/acordos\/?/, '');
  req.query = req.query || {};
  req.query.params = after ? after.split('/').filter(Boolean) : [];
  return handler(req, res);
};
