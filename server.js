const express = require('express');
const path = require('node:path');
const authRouter = require('./src/authRouter');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Idempotency-Key');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// Mount Authentication REST API
app.use('/api/v1/auth', authRouter);

// Serve static assets and web UI
app.use(express.static(path.join(__dirname)));

// 404 handler for API routes
app.use('/api', (req, res) => {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `The requested endpoint '${req.method} ${req.originalUrl}' does not exist.`
    }
  });
});

// Centralized error handler (5xx)
app.use((err, req, res, next) => {
  console.error('[server error]', err);
  const status = err.status || 500;
  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL_SERVER_ERROR',
      message: status === 500 ? 'An unexpected error occurred while processing the request.' : err.message
    }
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`OpenAPI documentation: http://localhost:${PORT}/api/v1/auth/openapi.json`);
  });
}

module.exports = app;
