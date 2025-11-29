// src/controllers/botLogsController.js
const { Router } = require('express');
const botLogsModel = require('../models/botLogs');

function BotLogsController() {
    const r = Router();

    // GET /api/bots/:id/logs?limit=200
    r.get('/:id/logs', async (req, res) => {
        try {
            const limit = Number(req.query.limit || 200);
            const logs = await botLogsModel.listByBot(req.params.id, limit);
            res.json(logs);
        } catch (err) {
            console.error('bot logs list error', err);
            res.status(500).json({ error: 'internal error' });
        }
    });

    return r;
}

module.exports = { BotLogsController };
