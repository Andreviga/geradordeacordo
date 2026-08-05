module.exports = (req, res) => {
  const url = process.env.DATABASE_URL || '';
  const parts = url.split('@');
  const host = parts.length > 1 ? parts[1].split('/')[0] : '(sem @)';
  const proto = url.substring(0, url.indexOf('://') + 3) || '(vazio)';
  let urlOk = false;
  try { new URL(url); urlOk = true; } catch(_){}
  res.json({ proto, host, len: url.length, urlOk });
};
