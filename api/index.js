'use strict';
/* Vercel serverless entry — every request (including vercel.json crons) lands here. */
const { app, init } = require('../server/app');

module.exports = async (req, res) => {
  await init();
  return app(req, res);
};
