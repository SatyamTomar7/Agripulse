function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: err.message || 'Internal server error',
    code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR')
  });
}
module.exports = errorHandler;
