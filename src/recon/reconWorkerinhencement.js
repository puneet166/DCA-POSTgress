// src/recon/reconWorker.js
/**
 * Reconciliation worker
 *
 * Responsibilities:
 *  - Periodically fetch trades & orders from exchanges for users who have active bots
 *  - Insert missing trades into bot_orders (idempotent)
 *  - Detect partial fills and update existing bot_orders and bot.entries
 *  - Persist ledger entries to Mongo (collection: ledger) and optionally to Postgres (PG_CONN)
 *  - Mark bots as closed when sells fully offset entries
 *  - Reconcile pending order_intents (if present)
 *
 * Config via ENV:
 *  - REDIS_URL (default redis://redis:6379)
 *  - MONGO_URI (used by src/lib/db.js)
 *  - PG_CONN (optional) => Postgres connection string for ledger writes
 *  - RECON_INTERVAL_MS (defaults to 15_000)
 *  - RECON_USER_BATCH (how many users to process per loop)
 *
 * Important:
 *  - This worker does not replace your accounting system; it ensures local DB reflects exchange trades.
 *  - Extend the ledger schema and reconciliation matching heuristics as needed for your exchange specifics.
 */
const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '../../.env')
});
const { initDb, getDb } = require('../lib/db');
const ExchangeAdapter = require('../lib/exchangeAdapter');
const IORedis = require('ioredis');
const RedisLock = require('../lib/lock');
const { v4: uuidv4 } = require('uuid');
const { Client: PgClient } = require('pg');
const botsModel = require('../models/bots');
const botOrders = require('../models/botOrders');
const redis = new IORedis(process.env.REDIS_URL || 'redis://redis:6379');
const lock = new RedisLock(redis);

const RECON_INTERVAL_MS = process.env.RECON_INTERVAL_MS ? Number(process.env.RECON_INTERVAL_MS) : 15_000;
const RECON_USER_BATCH = process.env.RECON_USER_BATCH ? Number(process.env.RECON_USER_BATCH) : 20;
const LOCK_TTL_MS = process.env.RECON_LOCK_TTL_MS ? Number(process.env.RECON_LOCK_TTL_MS) : 30_000;

let pg = null;
if (process.env.PG_CONN) {
  pg = new PgClient({ connectionString: process.env.PG_CONN });
}

async function init() {
  await initDb();
  if (pg) {
    await pg.connect();
    console.log('[RECON] Postgres ledger enabled');
  } else {
    console.log('[RECON] Postgres not configured, ledger writes will be stored in Mongo only');
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Insert ledger entry into Mongo and optionally Postgres.
 * Ledger schema (Mongo): { _id, userId, botId, type (buy|sell|fee), baseAsset, quoteAsset, amount, price, notional, fee, timestamp, meta }
 */
async function persistLedger(db, row) {
  row._id = row._id || uuidv4();
  row.timestamp = row.timestamp || new Date();
  await db.collection('ledger').insertOne(row);
  if (pg) {
    try {
      await pg.query(
        `INSERT INTO ledger (id, user_id, bot_id, type, base_asset, quote_asset, amount, price, notional, fee, meta, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          row._id, row.userId, row.botId, row.type, row.baseAsset, row.quoteAsset,
          row.amount, row.price, row.notional, row.fee || 0, JSON.stringify(row.meta || {}), row.timestamp
        ]
      );
    } catch (err) {
      console.error('[RECON] PG ledger insert failed', err.message);
      // Do NOT fail reconciliation on PG error; Mongo entry is persisted
    }
  }
}

/**
 * Try to find local bot_orders by exchange order id or trade id.
 * Returns: { found: boolean, order: doc|null }
 */
async function findOrderByExchangeId(db, trade) {
  if (!trade) return { found: false, order: null };
  // Common trade fields: trade.order (order id), trade.id (trade id), trade.info.orderId...
  const orderIdCandidates = new Set();
  if (trade.order) orderIdCandidates.add(String(trade.order));
  if (trade.info && (trade.info.orderId || trade.info.order_id)) {
    orderIdCandidates.add(String(trade.info.orderId || trade.info.order_id));
  }

  // Search by order id
  for (const oid of orderIdCandidates) {
    const doc = await db.collection('bot_orders').findOne({ orderId: oid });
    if (doc) return { found: true, order: doc };
  }

  // As fallback, search by trade id
  if (trade.id) {
    const doc = await db.collection('bot_orders').findOne({ 'raw.tradeId': String(trade.id) });
    if (doc) return { found: true, order: doc };
  }
  return { found: false, order: null };
}

/**
 * Update an existing bot_order with new fill info (idempotent)
 */
async function upsertBotOrderFromTrade(db, bot, trade) {
  // Find by orderId if possible
  const idCandidates = [];
  if (trade.order) idCandidates.push(String(trade.order));
  if (trade.info && (trade.info.orderId || trade.info.order_id)) idCandidates.push(String(trade.info.orderId || trade.info.order_id));
  const q = { $or: [] };
  if (idCandidates.length) q.$or.push({ orderId: { $in: idCandidates } });
  if (trade.id) q.$or.push({ 'raw.tradeId': String(trade.id) });

  const existing = q.$or.length ? await db.collection('bot_orders').findOne(q) : null;
  if (existing) {
    // Merge fill info: sum fills reported by exchange vs stored
    const existingFilled = Number(existing.amount || 0);
    const tradeAmount = Number(trade.amount || trade.qty || 0) || 0;
    // If trade maps to same order and we don't have this trade id recorded, update order and append trade to raw.trades
    const alreadyRecorded = (existing.raw && existing.raw.trades && existing.raw.trades.find(t => String(t.id || t.tradeId) === String(trade.id || trade.tradeId)));
    if (!alreadyRecorded) {
      // update filled amount and raw struct
      const newFilled = Number((existingFilled + tradeAmount).toFixed(12));
      const update = {
        $set: {
          amount: newFilled,
          price: existing.price || trade.price || trade.rate || existing.price
        },
        $push: { 'raw.trades': trade }
      };
      await db.collection('bot_orders').updateOne({ _id: existing._id }, update);
      return { updated: true, order: await db.collection('bot_orders').findOne({ _id: existing._id }) };
    } else {
      return { updated: false, order: existing }; // already present
    }
  } else {
    // No existing order, create a new bot_order record linked to bot if we can guess it (by botId) or leave botId null
    const orderDoc = {
      _id: uuidv4(),
      botId: bot ? bot._id : null,
      orderId: trade.order || (trade.info && (trade.info.orderId || trade.info.order_id)) || null,
      side: trade.side || (trade.info && trade.info.side) || null,
      amount: Number(trade.amount || trade.qty || 0),
      price: Number(trade.price || trade.rate || trade.cost / (trade.amount || trade.qty) || 0),
      fee: trade.fee || null,
      raw: { trade },
      reconciled: true,
      createdAt: new Date()
    };
    await botOrders.insertOrder(orderDoc);
    return { created: true, order: orderDoc };
  }
}

/**
 * Try to update bot.entries when an order has changed (e.g., partial fills or newly discovered fill).
 * If trade is buy, push entry; if it's sell, reduce entries or mark sold.
 */
async function applyTradeToBotEntries(db, bot, orderDoc) {
  if (!bot) return;
  // If orderDoc.side === 'buy' and not already represented in entries (unique by orderId/price+amount/time), append
  const side = (orderDoc.side || (orderDoc.raw && orderDoc.raw.trade && orderDoc.raw.trade.side) || '').toLowerCase();
  if (side === 'buy') {
    // Avoid duplicating an entry with same orderId
    const exists = (bot.entries || []).find(e => (e.orderId && orderDoc.orderId && e.orderId === orderDoc.orderId) || (Math.abs((e.price || 0) - (orderDoc.price || 0)) < 1e-8 && Math.abs((e.amount || 0) - (orderDoc.amount || 0)) < 1e-8));
    if (!exists) {
      const newEntry = { orderId: orderDoc.orderId || null, price: orderDoc.price, amount: orderDoc.amount, ts: new Date() };
      // await db.collection('bots').updateOne({ _id: bot._id }, { $push: { entries: newEntry } });
      await botsModel.pushEntry(botId, newEntry);

      return { applied: true, newEntry };
    }
  } else if (side === 'sell') {
    // For sells, compute total sold and if covers the bot.entries totalAmount, mark bot closed and record realized PnL
    const entries = bot.entries || [];
    const totalAmount = entries.reduce((s, e) => s + (Number(e.amount || 0)), 0);
    const totalSold = Number(orderDoc.amount || 0);
    if (totalSold >= totalAmount - 1e-12) {
      // full exit
      // compute avg price and realized pnl
      const totalNotional = entries.reduce((s, e) => s + (Number(e.price || 0) * Number(e.amount || 0)), 0);
      const avgPrice = totalAmount > 0 ? totalNotional / totalAmount : 0;
      const realizedNotional = (orderDoc.price || 0) * totalSold;
      const realizedPnL = realizedNotional - (avgPrice * totalSold);
      // Persist in ledger and mark bot closed (done by caller)
      await db.collection('bots').updateOne({ _id: bot._id }, { $set: { status: 'closed', closedAt: new Date(), realizedPnL, realizedNotional } });
      return { closed: true, realizedPnL, realizedNotional };
    } else {
      // Partial sell: reduce entries proportionally (simple approach)
      // Reduce entries starting FIFO until sold amount accounted
      let remaining = totalSold;
      const newEntries = [];
      for (const e of entries) {
        if (remaining <= 0) {
          newEntries.push(e);
          continue;
        }
        const amt = Number(e.amount || 0);
        if (amt <= remaining + 1e-12) {
          // consumed this entry
          remaining -= amt;
          continue;
        } else {
          // partially consume
          const left = Number((amt - remaining).toFixed(12));
          newEntries.push({ price: e.price, amount: left, ts: e.ts });
          remaining = 0;
        }
      }
      // Update bot entries
      await db.collection('bots').updateOne({ _id: bot._id }, { $set: { entries: newEntries } });
      return { partial: true, remainingSell: remaining };
    }
  }
  return { applied: false };
}

/**
 * Reconcile one bot for a user
 */
async function reconcileBotForUser(db, user, bot, adapter) {
  try {
    const symbol = bot.pair;
    // Fetch recent trades (limit configurable) and recent orders
    let trades = [];
    try {
      trades = await adapter.fetchMyTrades(symbol, undefined, 200);
    } catch (err) {
      console.warn(`[RECON] fetchMyTrades failed for user ${user._id} symbol ${symbol}: ${err.message}`);
      trades = [];
    }

    // Process trades
    for (const t of trades) {
      try {
        // Attempt to find matching local order or create/update
        const found = await findOrderByExchangeId(db, t);
        if (found.found) {
          // update with new trade info if needed
          const up = await upsertBotOrderFromTrade(db, bot, t);
          if (up && (up.updated || up.created)) {
            // try to apply to bot entries
            // const latestBot = await db.collection('bots').findOne({ _id: bot._id });
            const latestBot = await botsModel.findById(botId);

            await applyTradeToBotEntries(db, latestBot, up.order);
            // create ledger entry
            const row = {
              userId: user._id,
              botId: bot._id,
              type: (up.order.side || 'trade').toLowerCase(),
              baseAsset: symbol.split('/')[0],
              quoteAsset: symbol.split('/')[1],
              amount: up.order.amount,
              price: up.order.price,
              notional: (up.order.amount * up.order.price),
              fee: up.order.fee || (t.fee ? t.fee.cost : 0),
              meta: { reconciledFrom: 'trade', tradeId: t.id || null, orderId: up.order.orderId || null },
              timestamp: new Date(t.timestamp || t.datetime || Date.now())
            };
            await persistLedger(db, row);
          }
        } else {
          // No associated order: create a bot_order (best-effort attach to bot)
          const up = await upsertBotOrderFromTrade(db, bot, t);
          if (up && (up.created || up.updated)) {
            // const latestBot = await db.collection('bots').findOne({ _id: bot._id });
            const latestBot = await botsModel.findById(botId);

            await applyTradeToBotEntries(db, latestBot, up.order);
            const row = {
              userId: user._id,
              botId: bot._id,
              type: (up.order.side || 'trade').toLowerCase(),
              baseAsset: symbol.split('/')[0],
              quoteAsset: symbol.split('/')[1],
              amount: up.order.amount,
              price: up.order.price,
              notional: (up.order.amount * up.order.price),
              fee: up.order.fee || (t.fee ? t.fee.cost : 0),
              meta: { reconciledFrom: 'trade_unmatched', tradeId: t.id || null, orderId: up.order.orderId || null },
              timestamp: new Date(t.timestamp || t.datetime || Date.now())
            };
            await persistLedger(db, row);
          }
        }
      } catch (err) {
        console.error('[RECON] trade handling error', err.message);
      }
    }

    // Reconcile open/stale orders: fetch recent open orders and ensure bot_orders exist
    let orders = [];
    try {
      // many exchanges: fetchOrders can accept symbol; use limit small
      orders = await adapter.client.fetchOrders(symbol, undefined, 200);
    } catch (err) {
      // some exchanges do not implement fetchOrders reliably; ignore
      // fallback to fetchOpenOrders if available
      try {
        if (adapter.client.fetchOpenOrders) {
          orders = await adapter.client.fetchOpenOrders(symbol, undefined, 200);
        }
      } catch (err2) {
        console.warn(`[RECON] fetchOrders/fetchOpenOrders failed for ${symbol}: ${err2.message}`);
        orders = [];
      }
    }

    for (const ord of orders) {
      try {
        // Check if we have this order in bot_orders
        const known = await db.collection('bot_orders').findOne({ orderId: ord.id || ord.clientOrderId || (ord.info && (ord.info.orderId || ord.info.order_id)) });
        if (!known) {
          const doc = {
            _id: uuidv4(),
            botId: bot._id,
            orderId: ord.id || ord.clientOrderId || (ord.info && (ord.info.orderId || ord.info.order_id)) || null,
            side: ord.side,
            amount: ord.amount || ord.filled || 0,
            price: ord.price || ord.average || null,
            status: ord.status || 'open',
            raw: ord,
            reconciled: true,
            createdAt: new Date(ord.datetime || Date.now())
          };
          await botOrders.insertOrder(doc);
          // if filled amount > 0, apply to entries
          if (doc.amount > 0) {
            // const latestBot = await db.collection('bots').findOne({ _id: bot._id });
            const latestBot = await botsModel.findById(botId);

            await applyTradeToBotEntries(db, latestBot, doc);
            await persistLedger(db, {
              userId: user._id,
              botId: bot._id,
              type: doc.side,
              baseAsset: symbol.split('/')[0],
              quoteAsset: symbol.split('/')[1],
              amount: doc.amount,
              price: doc.price,
              notional: doc.amount * (doc.price || 0),
              fee: (ord.fee && ord.fee.cost) || 0,
              meta: { reconciledFrom: 'order' },
              timestamp: new Date(ord.datetime || Date.now())
            });
          }
        } else {
          // we have it; ensure amounts align (partial fills)
          // ord.filled may indicate additional fills after our record
          const ordFilled = Number(ord.filled || ord.amount || 0);
          if (ordFilled > (known.amount || 0)) {
            // update known order
            await db.collection('bot_orders').updateOne({ _id: known._id }, { $set: { amount: ordFilled, price: ord.average || known.price, raw: ord } });
            // const latestBot = await db.collection('bots').findOne({ _id: bot._id });
            const latestBot = await botsModel.findById(botId);

            await applyTradeToBotEntries(db, latestBot, { ...known, amount: ordFilled, price: ord.average || known.price, raw: ord });
            // ledger entry for delta
            const delta = ordFilled - (known.amount || 0);
            await persistLedger(db, {
              userId: user._id,
              botId: bot._id,
              type: known.side,
              baseAsset: symbol.split('/')[0],
              quoteAsset: symbol.split('/')[1],
              amount: delta,
              price: ord.average || known.price || 0,
              notional: delta * (ord.average || known.price || 0),
              fee: (ord.fee && ord.fee.cost) || 0,
              meta: { reconciledFrom: 'partial_fill' },
              timestamp: new Date()
            });
          }
        }
      } catch (err) {
        console.error('[RECON] order reconcile error', err.message);
      }
    }

    // Optionally: balance snapshot
    try {
      const balance = await adapter.fetchBalance();
      await db.collection('metrics').updateOne({ pair: symbol }, { $set: { lastBalanceSnapshot: balance, ts: new Date() } }, { upsert: true });
    } catch (err) {
      console.warn('[RECON] fetchBalance failed', err.message);
    }

    // Finally: if bot has entries and no open positions (exchange shows no position for this symbol),
    // check if local state thinks position open and mark closed if needed.
    // This logic requires exchange position model — for spot it's balance-check based
    try {
      // const botAfter = await db.collection('bots').findOne({ _id: bot._id });
      const botAfter = await botsModel.findById(botId);

      const totalAmount = (botAfter.entries || []).reduce((s, e) => s + Number(e.amount || 0), 0);
      if (totalAmount > 0) {
        // check balance for base asset
        const base = symbol.split('/')[0];
        const balance = await adapter.fetchBalance();
        const exchBaseAmount = (balance && balance.free && (balance.free[base] || 0)) || (balance && balance[base] && balance[base].free) || 0;
        if (exchBaseAmount <= 1e-12) {
          // exchange shows no base asset but bot has entries -> likely sold on exchange; mark closed
          await db.collection('bots').updateOne({ _id: bot._id }, { $set: { status: 'closed', closedAt: new Date() } });
          console.log(`[RECON] Bot ${bot._id} marked closed (exchange shows zero ${base})`);
        }
      }
    } catch (err) {
      // ignore non-critical
    }

  } catch (err) {
    console.error(`[RECON] reconcileBotForUser error bot ${bot._id}:`, err.message || err);
  }
}

async function reconcileUser(db, user) {
  const userLockKey = `recon-user-lock:${user._id}`;
  const token = await lock.acquire(userLockKey, LOCK_TTL_MS, 2000);
  if (!token) {
    // already reconciling this user elsewhere
    return;
  }
  try {
    // fetch bots for this user (running or recently active)
    const bots = await db.collection('bots').find({ userId: user._id }).toArray();
    if (!bots || bots.length === 0) return;

    // instantiate adapter per user (reuse across bots)
    const adapter = new ExchangeAdapter(user.apiKey, user.apiSecret, user.exchange || 'bybit');

    for (const bot of bots) {
      await reconcileBotForUser(db, user, bot, adapter);
    }

    // reconcile order_intents: find intents for this user that are pending and try to match exchange orders
    const intents = await db.collection('order_intents').find({ userId: user._id, status: 'pending' }).toArray().catch(()=>[]);
    for (const intent of intents) {
      try {
        // attempt to find exchange order
        const orderId = intent.expectedOrderId || intent.clientOrderId || null;
        if (orderId) {
          try {
            const ord = await adapter.client.fetchOrder(orderId);
            if (ord) {
              // persist as bot_orders if not present
              const exists = await db.collection('bot_orders').findOne({ orderId: orderId });
              if (!exists) {
                const doc = {
                  _id: uuidv4(),
                  botId: intent.botId || null,
                  orderId: orderId,
                  side: ord.side,
                  amount: ord.filled || ord.amount || 0,
                  price: ord.price || ord.average || null,
                  status: ord.status || null,
                  raw: ord,
                  reconciled: true,
                  createdAt: new Date(ord.datetime || Date.now())
                };
                await botOrders.insertOrder(doc);
                await db.collection('order_intents').updateOne({ _id: intent._id }, { $set: { status: 'resolved', resolvedAt: new Date(), resolvedOrderId: orderId } });
              } else {
                await db.collection('order_intents').updateOne({ _id: intent._id }, { $set: { status: 'resolved', resolvedAt: new Date(), resolvedOrderId: orderId } });
              }
            }
          } catch (err) {
            // fetchOrder may fail; leave intent pending for next run
          }
        }
      } catch (err) {
        console.error('[RECON] intent reconcile error', err.message);
      }
    }

  } finally {
    await lock.release(userLockKey, token).catch(()=>{});
  }
}

async function mainLoop() {
  await init();
  const db = getDb();
  console.log('[RECON] Starting reconciliation loop');
  while (true) {
    try {
      // pick a set of users that have bots (only users with API keys)
      const usersCursor = db.collection('users').find({ apiKey: { $exists: true } }).limit(RECON_USER_BATCH);
      const users = await usersCursor.toArray();
      if (!users || users.length === 0) {
        // nothing to do
        await sleep(RECON_INTERVAL_MS);
        continue;
      }

      for (const user of users) {
        try {
          await reconcileUser(db, user);
        } catch (err) {
          console.error('[RECON] error reconciling user', user._id, err.message || err);
        }
      }

    } catch (err) {
      console.error('[RECON] main loop error', err && err.message ? err.message : err);
    }

    await sleep(RECON_INTERVAL_MS);
  }
}

mainLoop().catch(err => {
  console.error('[RECON] fatal', err);
  process.exit(1);
});
