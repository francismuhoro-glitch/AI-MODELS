'use strict';
/* Vercel serverless entry.
   vercel.json rewrites /api/* here; the express app dual-mounts its routes at both
   "/" and "/api" and normalizes /api/index.js paths, so every shape resolves. */
const app = require('../server/app');

module.exports = async (req, res) => {
  try { await app.init(); } catch (_) { /* boot best-effort — handlers have their own fallbacks */ }
  return app(req, res);
};
