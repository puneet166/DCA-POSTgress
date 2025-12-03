// src/worker/botWorker.js
const { getDb, initDb } = require('../lib/db');
const path = require('path');
require('dotenv').config({
    path: path.join(__dirname, '../../.env')
});
const { RateLimiter } = require('../lib/rateLimiter');
const ExchangeAdapter = require('../lib/exchangeAdapter');
const { runDcaStep, checkExit } = require('../strategies/dca');
const RedisLock = require('../lib/lock');
const IORedis = require('ioredis');
const { enqueueBotTick, botQueue } = require('./queue');
const { logBot } = require('../lib/botLogger');
const { enqueueBotDelete } = require('./queue');

const botsModel = require('../models/bots');
const usersModel = require('../models/users');
const botOrders = require('../models/botOrders');
const metricsModel = require('../models/metrics');
const getUserExchangeKeys=require("../services/getExchangeKeys") // this function will call where use of apikey and secret

const limiter = new RateLimiter();
const redis = new IORedis(process.env.REDIS_URL || 'redis://redis:6379');
const lock = new RedisLock(redis);

/**
 * Settings: tuned for sensible defaults.
 * - LOCK_TTL_MS: how long the lock lives (should exceed worst-case tick duration)
 * - LOCK_WAIT_MS: how long this worker will wait trying to acquire the lock
 * - LOCK_RENEW_THRESHOLD_MS: when to renew lock if still running (we'll renew when remaining TTL < threshold)
 */
const LOCK_TTL_MS = process.env.LOCK_TTL_MS ? Number(process.env.LOCK_TTL_MS) : 30000; // 30s
const LOCK_WAIT_MS = process.env.LOCK_WAIT_MS ? Number(process.env.LOCK_WAIT_MS) : 5000; // 5s
const LOCK_RENEW_THRESHOLD_MS = process.env.LOCK_RENEW_THRESHOLD_MS ? Number(process.env.LOCK_RENEW_THRESHOLD_MS) : 10000; // 10s

class BotWorker {

    async handle(job) {
        try {
            await initDb();
        } catch (err) {
            console.error('Failed to init DB in BotWorker.handle', err);
            throw err;
        }
        const { name, data } = job;
        if (name === 'start-bot') return this.startBot(data.botId);
        if (name === 'bot-tick') return this.tickBot(data.botId);
        if (name === 'delete-bot') return this.deleteBot(data.botId);

        return;
    }

    /**
     * startBot: set bot.status = 'running' and schedule first tick
     */
    async startBot(botId) {
        // load bot via model
        const bot = await botsModel.findById(botId);
        if (!bot) throw new Error('bot not found');

        // set status to running
        // await botsModel.setStatus(botId, 'running');

        // enqueue first tick
        // await enqueueBotTick(botId);
    }

    /**
     * tickBot: main bot tick loop (acquires distributed lock, fetches ticker/metrics,
     * decides exit or buy, places order, persists order + entry, schedules next tick)
     */
    async tickBot(botId) {
        await logBot(botId, 'tick_started');

        // Ensure DB available (initDb already called in handle)
        const lockKey = `bot-lock:${botId}`;

        // Try to acquire lock for this bot
        const token = await lock.acquire(lockKey, LOCK_TTL_MS, LOCK_WAIT_MS);

        if (!token) {
            // Could not obtain lock — another worker is processing this bot.
            await logBot(botId, 'lock_not_acquired', 'warn');

            try {
                const currentBot = await botsModel.findById(botId);
                if (currentBot && currentBot.status === 'running') {
                    setTimeout(() => enqueueBotTick(botId).catch(console.error), 500 + Math.floor(Math.random() * 500));
                } else {
                    console.log(`Bot ${botId} is not running (status=${currentBot ? currentBot.status : 'not found'}), will not re-enqueue tick.`);
                }
            } catch (err) {
                console.error('Error checking bot status before re-enqueue', err);
            }
            return;
        }

        await logBot(botId, 'lock_acquired', 'info');

        // We acquired the lock. Ensure release in finally.
        let renewedInterval = null;
        try {
            // start a small renew loop to keep TTL alive if operation runs longer than TTL
            renewedInterval = setInterval(async () => {
                try {
                    await lock.renew(lockKey, token, LOCK_TTL_MS);
                } catch (e) {
                    console.error('lock renew error', e);
                }
            }, Math.max(LOCK_TTL_MS - LOCK_RENEW_THRESHOLD_MS, 1000));

            // fetch fresh bot & user inside lock to ensure consistent read -> write
            const bot = await botsModel.findById(botId);
            if (!bot) {
                console.warn(`Bot ${botId} not found`);
                return;
            }

            const user = await getUserExchangeKeys(bot.user_id || bot.userId || bot.user); // tolerate naming variations
            if (!user) {
                console.warn(`User ${bot.user_id || bot.userId} not found for bot ${botId}`);
                return;
            }

            const exchangeId = user.exchange || 'bybit';
            const adapter = new ExchangeAdapter(user.api_key || user.apiKey, user.api_secret || user.apiSecret, exchangeId);
            const exchangeKey = adapter.exchangeKey;

            // Acquire token for reading ticker (and/or metrics)
            const gotTokenForTicker = await limiter.acquire(exchangeKey, 1, Number(process.env.RATE_LIMIT_ACQUIRE_MS || 5000));
            if (!gotTokenForTicker) {
                console.warn(`[Worker] Rate limiter timeout before fetching ticker for bot ${botId} (exchange=${exchangeId})`);
                try { await logBot(botId, 'rate_limit_timeout', 'warn', { stage: 'fetchTicker', exchange: exchangeId }); } catch (e) { console.error('logBot failed', e); }
                // bail this tick (we will be rescheduled by caller if bot remains running)
                return;
            }

            // Prefer reading metrics via model
            const metricsDoc = await metricsModel.findByPair(bot.pair);
            const metrics = (metricsDoc && metricsDoc.last_balance_snapshot) ? metricsDoc.last_balance_snapshot : (bot.config && bot.config.metrics) || {};

            let ticker;
            try {
                ticker = await adapter.fetchTicker(bot.pair);
                await logBot(botId, 'ticker_fetched', 'info', { price: ticker && ticker.last ? ticker.last : null });
            } catch (err) {
                console.error(`[Worker] fetchTicker failed for bot ${botId} ${bot.pair}`, err && (err.message || err));
                await logBot(botId, 'exchange_error', 'error', {
                    stage: 'fetchTicker',
                    pair: bot.pair,
                    message: err && (err.message || String(err)),
                });
                // cannot proceed without ticker
                return;
            }

            // 1) Check exits first (TP/SL)
            const exitDecision = await checkExit(bot, ticker);
            console.log(`checkExit for bot ${botId}`);
            await logBot(botId, 'exit_decision', 'info', exitDecision);

            if (exitDecision.placeOrder) {
                const gotTokenForSell = await limiter.acquire(exchangeKey, 1, Number(process.env.RATE_LIMIT_ACQUIRE_MS || 5000));
                if (!gotTokenForSell) {
                    console.warn(`[Worker] Rate limiter timeout before placing sell for bot ${botId}`);
                    try { await logBot(botId, 'rate_limit_timeout', 'warn', { stage: 'placeSell' }); } catch (e) { console.error('logBot failed', e); }
                    return;
                }

                let sellOrder;
                try {
                    sellOrder = await adapter.createOrder(exitDecision.orderParams);
                    await logBot(botId, 'sell_order_placed', 'info', { sellOrder, exitType: exitDecision.exitType, reason: exitDecision.reason });
                } catch (err) {
                    console.error('Sell order failed', err);
                    await logBot(botId, 'sell_order_failed', 'error', { error: err && err.message ? err.message : String(err) });
                    throw err;
                } finally {
                    await limiter.release(exchangeKey, 1);
                }
                // persist sell order via model (with safe fallbacks for amount & price)
                try {
                    // Determine persisted amount (prefer filled, then reported amount, then intended order amount)
                    const persistedAmount = (sellOrder && (Number(sellOrder.filled) || Number(sellOrder.amount))) || Number(exitDecision.orderParams.amount) || 0;

                    // Determine persisted price: prefer explicit exchange price/average, then exitDecision.price, then ticker.last
                    let persistedPrice = (sellOrder && (sellOrder.price || sellOrder.average)) || (exitDecision.orderParams && exitDecision.orderParams.price) || null;
                    if (!persistedPrice && ticker) {
                        persistedPrice = ticker.last || ticker.close || null;
                    }
                    // ensure numeric
                    persistedPrice = persistedPrice != null ? Number(persistedPrice) : 0;

                    // persist sell order via model
                    // try {
                        await botOrders.insertOrder({
                            botId,
                            orderId: sellOrder.id || null,
                            side: 'sell',
                            amount: persistedAmount,
                            price: persistedPrice,
                            raw: sellOrder,
                            exitType: exitDecision.exitType,
                            reason: exitDecision.reason,
                            createdAt: new Date()
                        });
                    } catch (err) {
                        console.error('Failed to persist sell order', err);
                        // continue — order was placed on exchange; persistence failure should be retried/inspected separately
                    }

                    // mark bot closed
                    await botsModel.setClosed(botId);
                    console.log(`Bot ${botId} exited by ${exitDecision.exitType}: ${exitDecision.reason}`);
                    await logBot(botId, 'bot_closed', 'info', { exitType: exitDecision.exitType });

                    try {
                        const jobId = `tick:${botId}`;
                        await botQueue.remove(jobId);
                        console.log(`Removed queued tick job ${jobId} after exit.`);
                    } catch (err) {
                        console.warn(`Failed to remove queued tick job for ${botId}`, err);
                    }

                    return;
                }

            // 2) Evaluate buy
            const buyDecision = await runDcaStep(bot, ticker, metrics);
                await logBot(botId, 'buy_decision', 'info', buyDecision);

                if (buyDecision.placeOrder) {
                    const gotTokenForBuy = await limiter.acquire(exchangeKey, 1, Number(process.env.RATE_LIMIT_ACQUIRE_MS || 5000));
                    if (!gotTokenForBuy) {
                        console.warn(`[Worker] Rate limiter timeout before placing buy for bot ${botId}`);
                        try { await logBot(botId, 'rate_limit_timeout', 'warn', { stage: 'placeBuy' }); } catch (e) { console.error('logBot failed', e); }
                        return;
                    }

                    let buyOrder;
                    try {
                        buyOrder = await adapter.createOrder(buyDecision.orderParams);
                        await logBot(botId, 'buy_order_placed', 'info', { buyOrder });
                    } catch (err) {
                        console.error('Buy order failed', err);
                        await logBot(botId, 'buy_order_failed', 'error', { error: err && err.message ? err.message : String(err) });
                        throw err;
                    } finally {
                        await limiter.release(exchangeKey, 1);
                    }

                    // persist buy order
                    try {
                        await botOrders.insertOrder({
                            botId,
                            orderId: buyOrder.id || null,
                            side: 'buy',
                            amount: buyOrder.filled || buyDecision.orderParams.amount,
                            price: buyOrder.price || buyOrder.average || ticker.last,
                            raw: buyOrder,
                            createdAt: new Date()
                        });
                    } catch (err) {
                        console.error('Failed to persist buy order', err);
                    }

                    // update entries atomically (append JSON object to JSONB array)
                    const newEntry = {
                        price: buyOrder.price || buyOrder.average || ticker.last,
                        amount: buyOrder.filled || buyDecision.orderParams.amount,
                        ts: new Date()
                    };
                    try {
                        await botsModel.pushEntry(botId, newEntry);
                        await logBot(botId, 'entry_added', 'info', newEntry);
                    } catch (err) {
                        console.error('Failed to push entry to bot', err);
                    }
                }

            } finally {
                // clear renew loop
                if (renewedInterval) clearInterval(renewedInterval);

                // Release lock (best-effort)
                try {
                    if (token) {
                        const released = await lock.release(lockKey, token);
                        if (!released) {
                            console.warn(`Lock ${lockKey} release returned false (token mismatch or already expired)`);
                        }
                    }
                } catch (e) {
                    console.error('Error releasing lock', e);
                }

                // schedule next tick if bot still running
                try {
                    const latestBot = await botsModel.findById(botId);
                    if (latestBot && latestBot.status === 'running') {
                        await logBot(botId, 'next_tick_scheduled');
                        setTimeout(
                            () => enqueueBotTick(botId).catch(console.error),
                            (process.env.BOT_TICK_MS ? Number(process.env.BOT_TICK_MS) : 60_000)
                        );
                    } else {
                        console.log(`Bot ${botId} is not running anymore (status=${latestBot ? latestBot.status : 'not found'}). Not scheduling next tick.`);
                    }
                } catch (err) {
                    console.error('Error checking bot status before scheduling next tick', err);
                }
            }
        }

    async deleteBot(botId) {
            console.log("deleteBot start:", botId);
            const lockKey = `bot-lock:${botId}`;

            // acquire lock so delete does not conflict with tick
            const token = await lock.acquire(lockKey, LOCK_TTL_MS, LOCK_WAIT_MS);
            if (!token) {
                console.log(`deleteBot: Could not acquire lock, re-enqueueing`);
                setTimeout(() => enqueueBotDelete(botId).catch(console.error), 500 + Math.random() * 500);
                return;
            }

            // keep renewing lock while we work
            let renewed = setInterval(() => {
                lock.renew(lockKey, token, LOCK_TTL_MS).catch(console.error);
            }, Math.max(LOCK_TTL_MS - LOCK_RENEW_THRESHOLD_MS, 1000));

            try {
                await logBot(botId, 'delete_started', 'info');

                // reload bot inside lock
                const bot = await botsModel.findById(botId);
                if (!bot) {
                    console.warn(`deleteBot: bot ${botId} not found`);
                    return;
                }

                // mark as deleting (so UI/other code know)
                try {
                    await botsModel.updatePartial(botId, { status: 'deleting', updated_at: new Date() });
                } catch (err) {
                    console.warn('deleteBot: could not set status deleting', err);
                }

                // compute position size from entries
                const entries = bot.entries || [];
                const totalAmount = entries.reduce((sum, e) => sum + Number(e.amount || 0), 0);

                // fetch the user properly using Postgres model (not Mongo)
                const userId = bot.user_id || bot.userId || bot.user;
                const user = userId ? await getUserExchangeKeys(userId) : null;

                // If we have an open position and a valid user, attempt to close it on exchange
                if (totalAmount > 0 && user) {
                    const adapter = new ExchangeAdapter(user.api_key || user.apiKey, user.api_secret || user.apiSecret, user.exchange || 'bybit');
                    const exchangeKey = adapter.exchangeKey;

                    const got = await limiter.acquire(exchangeKey, 1, Number(process.env.RATE_LIMIT_ACQUIRE_MS || 5000));
                    if (got) {
                        try {
                            const sellParams = {
                                symbol: bot.pair,
                                side: 'sell',
                                type: 'market',
                                amount: totalAmount
                            };
                            const placed = await adapter.createOrder(sellParams);
                            // persist sell order (with fallback to ticker if the exchange didn't return a price)
                            try {
                                // compute persisted amount (prefer filled or reported, fallback to attempted totalAmount)
                                const persistedAmount = (placed && (Number(placed.filled) || Number(placed.amount))) || Number(totalAmount) || 0;

                                // compute persisted price: prefer exchange price/average -> try to fetch ticker -> fallback to 0
                                let persistedPrice = (placed && (placed.price || placed.average)) || null;
                                if (!persistedPrice) {
                                    try {
                                        // try to fetch a fresh ticker price for fallback
                                        const fallbackTicker = await adapter.fetchTicker(bot.pair);
                                        persistedPrice = fallbackTicker && (fallbackTicker.last || fallbackTicker.close) ? Number(fallbackTicker.last || fallbackTicker.close) : null;
                                    } catch (e) {
                                        // ignore — will fallback to 0
                                        console.warn('deleteBot: fetchTicker fallback failed', e && e.message ? e.message : e);
                                    }
                                }
                                persistedPrice = persistedPrice != null ? Number(persistedPrice) : 0;
                                // persist sell order
                                // try {
                                    await botOrders.insertOrder({
                                        botId,
                                        orderId: placed.id || null,
                                        side: 'sell',
                                        amount: persistedAmount,
                                        price: persistedPrice,
                                        raw: placed,
                                        exitType: 'manual_delete',
                                        reason: 'manual delete - force close',
                                        createdAt: new Date()
                                    });
                                } catch (errPersist) {
                                    console.error('deleteBot: failed to persist delete sell order', errPersist);
                                }

                                await logBot(botId, 'delete_sell_placed', 'info', { placed });
                            } catch (errSell) {
                                console.error('deleteBot: sell during delete failed', errSell && (errSell.message || errSell));
                                await logBot(botId, 'delete_sell_failed', 'error', { error: errSell && (errSell.message || String(errSell)) });
                            } finally {
                                await limiter.release(exchangeKey, 1).catch(e => console.error('deleteBot: limiter.release failed', e));
                            }
                        } else {
                            console.warn(`deleteBot: rate limiter prevented sell for ${botId}`);
                            await logBot(botId, 'rate_limit_prevented_delete_sell', 'warn');
                        }
                    } else {
                        console.debug(`deleteBot: nothing to sell or no user found for ${botId}`);
                    }

                    // remove bot tick job (best-effort)
                    try {
                        await botQueue.remove(`tick:${botId}`);
                        console.log(`deleteBot: removed tick job tick:${botId}`);
                    } catch (err) {
                        console.warn('deleteBot: remove tick failed', err);
                    }

                    // soft delete the bot (ensure this always runs when we've reached here)
                    try {
                        await botsModel.markDeleted(botId);
                        await logBot(botId, 'bot_deleted', 'info');
                        console.log(`deleteBot: bot ${botId} marked deleted`);
                    } catch (err) {
                        console.error('deleteBot: markDeleted failed', err);
                        await logBot(botId, 'bot_deleted_failed', 'error', { error: err && (err.message || String(err)) });
                    }

                } finally {
                    clearInterval(renewed);
                    try {
                        await lock.release(lockKey, token);
                    } catch (err) {
                        console.error('deleteBot: lock release failed', err);
                    }
                }
            }



}

        module.exports = BotWorker;
