'use strict';

require('dotenv').config();

const express = require('express');
const { requireReceiverAuth } = require('./middleware/auth');
const awgRoutes = require('./routes/awg');

const app = express();
app.disable('x-powered-by');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 42842);

if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Nait-AWG Receiver must bind to 127.0.0.1 on a valid port');
}

app.use(express.json({ limit: '3mb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'nait-awg-receiver' }));
app.use(requireReceiverAuth);
app.use('/awg', awgRoutes);
app.use((_req, res) => res.status(404).json({ error: 'Not Found' }));
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.type === 'entity.too.large' ? 413
    : error.type === 'entity.parse.failed' || error.status === 400 ? 400
    : error.status === 415 ? 415 : 500;
  // Parsing errors may contain raw configs; never echo them to the caller.
  res.status(status).json({ error: status === 413 ? 'Request too large'
    : status < 500 ? 'Invalid request' : 'Internal Server Error' });
});

if (require.main === module) {
  app.listen(port, host, () => console.log(`Nait-AWG Receiver on ${host}:${port}`));
}

module.exports = app;
