// src/middleware/authProxy.js
const axios = require('axios');

const authBase = process.env.AUTH_SERVICE_URL || 'http://host.docker.internal:3000/internal/auth'; // override in env

const api = axios.create({
  baseURL: authBase,
  timeout: 3000,
});

async function authenticateUser(req, res, next) {
  try {
    // Accept Bearer token in Authorization header or token header
    const tokenFromHeader = req.headers.authorization 
      ? req.headers.authorization.replace(/^Bearer\s+/i, '') 
      : (req.headers.token || req.body.token || null);

    if (!tokenFromHeader) {
      return res.status(401).json({ error: 'token missing' });
    }

    // Call Auth service internal verify endpoint
    const resp = await api.post('/verify-token', { token: tokenFromHeader }, {
      headers: { Authorization: `Bearer ${tokenFromHeader}` } // optional
    });

    if (!resp.data || !resp.data.success) {
      return res.status(401).json({ error: 'invalid token' });
    }

    const { user } = resp.data;
    
    // Attach info to req so controllers can use it
    req.userId = user.id;
    req.userDetails = user;

    next();
  } catch (err) {
    if (err.response) {
      // forward auth errors
      const status = err.response.status === 404 ? 401 : err.response.status;
      return res.status(status).json({ error: 'auth service error', details: err.response.data });
    }
    console.error('authProxy error', err.message || err);
    return res.status(500).json({ error: 'auth verification failed' });
  }
}

module.exports = authenticateUser;
