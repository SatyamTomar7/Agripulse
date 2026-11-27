const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const errorHandler = require('./middleware/errorHandler');
const routes = require('./routes');

function createApp(io) {
  const app = express();
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 300 }));
  app.set('io', io);
  app.use('/api/v1', routes);
  app.get('/api/health', (req, res) => res.json({ success: true }));
  app.use(errorHandler);
  return app;
}

module.exports = createApp;
