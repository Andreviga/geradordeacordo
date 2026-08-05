module.exports = (req, res) => {
  const url = process.env.DATABASE_URL || '';
  const parts = url.split('@');
  const host = parts.length > 1 ? parts[1].split('/')[0] : '(sem @)';
  const proto = url.split('://')[0] || '(vazio)';
  res.json({ proto, host, len: url.length });
};
