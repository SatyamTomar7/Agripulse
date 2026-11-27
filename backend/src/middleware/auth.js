const jwt = require('jsonwebtoken');

function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Authentication required', code: 'UNAUTHORIZED' });
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      return res.status(500).json({ success: false, message: 'Server authentication requires a JWT_SECRET of at least 32 bytes', code: 'AUTH_CONFIG_ERROR' });
    }
    req.user = jwt.verify(token, secret);
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token', code: 'UNAUTHORIZED' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Forbidden for this role', code: 'FORBIDDEN' });
    }
    next();
  };
}

module.exports = { verifyToken, requireRole };
