// src/recon/reconWorker.js (Postgres version)

const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '../../.env')
});

const ExchangeAdapter = require('../lib/exchangeAdapter');
const { initDb } = require('../lib/db');
const { v4: uuidv4 } = require('uuid');

const botsModel = require('../models/bots');
const usersModel = require('../models/users');
const botOrders = require('../models/botOrders');
const metricsModel = require('../models/metrics');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runReconciliation() {
    await initDb();

    console.log("[RECON] Reconciliation worker started");

    while (true) {
        try {
            // ------------------------------------------
            // Load all running bots
            // ------------------------------------------
            let bots = await botsModel.findAll();
            bots = bots.filter(b => b.status === "running");

            for (const bot of bots) {

                // ------------------------------------------
                // Load user for this bot
                // ------------------------------------------
                const user = await usersModel.findById(bot.user_id || bot.userId);

                if (!user) {
                    console.warn(`[RECON] Missing user for bot ${bot.id}`);
                    continue;
                }

                const adapter = new ExchangeAdapter(
                    user.api_key || user.apiKey,
                    user.api_secret || user.apiSecret,
                    user.exchange || 'bybit'
                );

                // ------------------------------------------
                // 1. Fetch recent trades from exchange
                // ------------------------------------------
                let trades = [];
                try {
                    trades = await adapter.fetchMyTrades(bot.pair, undefined, 50);
                } catch (err) {
                    console.error(`[RECON] error fetching trades for ${bot.pair}:`, err.message);
                    continue;
                }

                // ------------------------------------------
                // 2. For each trade, check if local DB has a matching bot_order entry
                // ------------------------------------------
                for (const t of trades) {
                    const orderId = t.order;

                    // Query Postgres for an existing order
                    const exists = await botOrders.findByOrderId?.(orderId);

                    if (!exists) {
                        console.log(`[RECON] Missing trade ${t.id} for bot ${bot.id}, inserting...`);

                        await botOrders.insertOrder({
                            botId: bot.id,
                            orderId: orderId,
                            side: t.side,
                            amount: t.amount,
                            price: t.price,
                            raw: t,
                            exitType: null,
                            reason: "reconciled",
                            createdAt: new Date()
                        });

                        // OPTIONAL: If needed, we can also auto-patch entries:
                        // await botsModel.pushEntry(bot.id, { price: t.price, amount: t.amount, ts: new Date() });
                    }
                }

                // ------------------------------------------
                // 3. Balance snapshot → METRICS table
                // ------------------------------------------
                try {
                    const balance = await adapter.fetchBalance();

                    await metricsModel.upsertMetrics(
                        bot.pair,
                        balance
                    );

                } catch (err) {
                    console.error("[RECON] balance error:", err.message);
                }
            }

        } catch (err) {
            console.error("[RECON] fatal loop error:", err);
        }

        await sleep(10000); // run every 10 seconds
    }
}

runReconciliation().catch((err) => {
    console.error("[RECON] fatal error:", err);
});
