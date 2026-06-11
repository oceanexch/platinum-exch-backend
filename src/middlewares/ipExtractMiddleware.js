const extractClientIp = (req, res, next) => {
  const raw =
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    '';

  req.clientIp = raw.replace(/^::ffff:/, '');
  req.ip = req.clientIp;
  next();
};

module.exports = extractClientIp;
