require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');              // ⬅️ add this

const { initDb, closeDb } = require('./lib/db');
const { initLogger } = require('./lib/logger');
const { PnlController } = require('./controllers/pnlController');

const { BotController } = require('./controllers/botController');
const { UserController } = require('./controllers/userController');
const { BotLogsController } = require('./controllers/botLogsController');

// const { initSocketServer } = require('./ws/socketServer');

const logger = initLogger();

async function main() {
    try {
        await initDb();   // Postgres is initialized here
        logger.info("Database initialized");
    } catch (err) {
        console.error("[API] Failed to initialize database:", err);
        process.exit(1);
    }

    const app = express();
    // 🔑 CORS CONFIG
   // ✅ CORS: allow ALL origins (no restrictions)
    app.use(cors());                 // Access-Control-Allow-Origin: *
    app.options('*', cors());        // Handle preflight for all routes

    app.use(bodyParser.json());

    // app.use(bodyParser.json());

    // Health check
    app.get('/health', (req, res) => res.json({ ok: true, ts: new Date() }));

    // REST API modules
    app.use('/api/bots', BotController());
    app.use('/api/users', UserController());
    app.use('/api/bot-logs', BotLogsController());
    app.use('/api/bots', PnlController());

    const port = process.env.PORT || 3000;
    const server = app.listen(port, () => {
        logger.info(`API listening on port ${port}`);
    });

    // Shutdown handler (recommended)
    process.on('SIGINT', async () => {
        logger.info("Shutting down API...");
        await closeDb();      // Close Postgres pool
        server.close(() => process.exit(0));
    });

    process.on('SIGTERM', async () => {
        logger.info("Shutting down API...");
        await closeDb();
        server.close(() => process.exit(0));
    });

    // If you use websockets later:
    // initSocketServer(server);
}

main().catch(err => {
    console.error("[API] fatal error:", err);
    process.exit(1);
});
