// src/lib/botLogger.js
const botLogsModel = require('../models/botLogs');
// const { getSocketIO } = require('../ws/socketServer');

async function logBot(botId, event, level = 'info', meta = {}) {
    const logEntry = {
        botId,
        event,
        level,
        meta,
        ts: new Date()
    };

    try {
        await botLogsModel.insertLog({ botId, event, level, meta, ts: logEntry.ts });
    } catch (err) {
        console.error('[botLogger] failed to save log:', err);
    }

    // WS emit code (if you re-enable socket server) can go here.
}

module.exports = { logBot };
