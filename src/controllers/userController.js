// src/controllers/userController.js
const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const usersModel = require('../models/users');

function UserController(){
  const r = Router();

  // Create user (DEV only: do not expose this in production without auth)
  r.post('/', async (req, res) => {
    const body = req.body || {};
    const apiKey = body.apiKey;
    const apiSecret = body.apiSecret;
    const exchange = body.exchange || 'bybit';
    const id = body._id || uuidv4();

    if(!apiKey || !apiSecret) {
      return res.status(400).json({ error: 'apiKey and apiSecret are required' });
    }

    try {
      await usersModel.createOrUpdateUser({ id, apiKey, apiSecret, exchange });
      return res.json({ id });
    } catch (err) {
      console.error('User create error', err);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // Get user by id
  r.get('/:id', async (req, res) => {
    try {
      const u = await usersModel.findById(req.params.id);
      if(!u) return res.status(404).send('not found');
      // For dev only - returns apiSecret too (be careful in production)
      return res.json(u);
    } catch (err) {
      console.error('get user error', err);
      res.status(500).send('internal error');
    }
  });

  // Optional: list users (small convenience)
  r.get('/', async (req, res) => {
    try {
      const users = await usersModel.listAll();
      // hide apiSecret
      const sanitized = users.map(u => ({ id: u.id, api_key: u.api_key, exchange: u.exchange, created_at: u.created_at }));
      return res.json(sanitized);
    } catch (err) {
      console.error('list users error', err);
      res.status(500).send('internal error');
    }
  });

  return r;
}

module.exports = { UserController };
