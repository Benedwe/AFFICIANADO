'use strict';

module.exports = async function handler(req, res) {
  try {
    const { handleRequest } = require('../server');
    await handleRequest(req, res);
  } catch (error) {
    console.error('Vercel request handler failed.', error);
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'The request could not be completed.' }));
    }
  }
};
