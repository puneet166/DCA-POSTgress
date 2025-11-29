// src/worker/workerPool.js
const { Worker, QueueScheduler } = require('bullmq'); // <-- import QueueScheduler
const IORedis = require('ioredis');
const path = require('path');
const { enqueueBotTick, botQueue } = require('./queue');

require('dotenv').config({
    path: path.join(__dirname, '../../.env')
});
const connection = new IORedis(process.env.REDIS_URL || 'redis://redis:6379');
const BotWorker = require('./botWorker');
const { initDb } = require('../lib/db');
const botsModel = require('../models/bots');


// Global error handlers (worker-only)
process.on('unhandledRejection', (reason, p) => {
  console.error('[Worker] Unhandled Rejection at:', p, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Worker] Uncaught Exception:', err);
  // Optional: exit to allow PM2 / Docker / systemd to restart worker
  // process.exit(1);
});

async function start() {
    // Ensure DB is initialized before starting to process jobs
    try {
        await initDb();
        console.log('[WORKER] DB initialized, starting worker...');
    } catch (err) {
        console.error('[WORKER] Failed to init DB, aborting worker start', err);
        throw err;
    }

    // Start QueueScheduler to handle stalled jobs, delayed retries and job timeouts
    // Important: one scheduler instance should run per queue (multiple schedulers are harmless but not needed)
    const scheduler = new QueueScheduler('bots', { connection });
    await scheduler.waitUntilReady();
    console.log('[WORKER] QueueScheduler ready for queue "bots"');

    // Recover: ensure all currently-running bots have a tick job scheduled (idempotent)
    try {
        // Use model to fetch running bots
        let runningBots = [];
        try {
            // If your botsModel implements a findByStatus method, prefer that.
            // Fallback: load all and filter.
            if (typeof botsModel.findByStatus === 'function') {
                runningBots = await botsModel.findByStatus('running');
            } else {
                const all = await botsModel.findAll();
                runningBots = (all || []).filter(b => b.status === 'running');
            }
        } catch (errInner) {
            console.error('[WORKER] Failed to load running bots via model, falling back to empty list', errInner);
            runningBots = [];
        }

        console.log(`[WORKER] Found ${runningBots.length} bots with status=running. Ensuring tick jobs exist...`);
        for (const b of runningBots) {
            try {
                // b.id is the Postgres UUID primary key
                const botId = b.id || b._id || b.botId;
                await enqueueBotTick(botId);
                console.log(`[WORKER] Enqueued tick for running bot ${botId}`);
            } catch (err) {
                console.error(`[WORKER] Failed to enqueue tick for ${b.id || b._id}:`, err && err.message ? err.message : err);
            }
        }
    } catch (err) {
        console.error('[WORKER] Recovery scan failed', err);
    }

    const worker = new Worker('bots', async (job) => {
        const w = new BotWorker();
        return w.handle(job);
    }, { connection, concurrency: Number(process.env.WORKER_CONCURRENCY || 2) });

    worker.on('failed', (job, err) => {
        console.error('Job failed', job.id, err);
    });

    worker.on('error', (err) => {
        console.error('Worker error', err);
    });

    console.log('Worker started');
}

if (require.main === module) {
    start().catch(err => {
        console.error('Worker failed to start', err);
        process.exit(1);
    });
}

module.exports = start;
