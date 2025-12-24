// src/controllers/pnlController.js
// API: GET /api/bots/:id/pnl
// Returns realized P&L only (FIFO matching of buy/sell orders)

const { Router } = require('express');
const db = require('../lib/pgClient');
const botsModel = require('../models/bots');
const authenticateUser = require('../middleware/authProxy');
// const usersModel = require('../models/users');
const ExchangeAdapter = require('../lib/exchangeAdapter');
const getUserExchangeKeys = require("../services/getExchangeKeys") // this function will call where use of apikey and secret

function round(n, decimals = 8) {
  if (typeof n !== 'number' || !isFinite(n)) return 0;
  const p = Math.pow(10, decimals);
  return Math.round(n * p) / p;
}

function computeUnrealizedPnl({ entries = [], currentPrice }) {
  let totalAmount = 0;
  let totalCost = 0;

  for (const e of entries) {
    const price = Number(e.price || 0);
    const amount = Number(e.amount || 0);
    if (!price || !amount) continue;

    totalAmount += amount;
    totalCost += price * amount;
  }

  if (totalAmount <= 0 || totalCost <= 0 || !currentPrice) {
    return {
      totalAmount: 0,
      avgEntryPrice: 0,
      currentPrice: currentPrice || 0,
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
      currentValue: 0
    };
  }

  const currentValue = totalAmount * currentPrice;
  const unrealizedPnl = currentValue - totalCost;
  const unrealizedPnlPct = (unrealizedPnl / totalCost) * 100;

  return {
    totalAmount,
    avgEntryPrice: round(totalCost / totalAmount, 8),
    currentPrice,
    currentValue: round(currentValue, 8),
    unrealizedPnl: round(unrealizedPnl, 8),
    unrealizedPnlPct: round(unrealizedPnlPct, 4)
  };
}


/**
 * Compute realized PnL using FIFO matching of buys -> sells
 * Orders must be ordered by time ASC to apply FIFO correctly
 */
function computeRealizedPnlFromOrders(orders) {
  const buyQueue = [];// { amount, price }
  let realizedPnl = 0;
  let realizedNotionalSold = 0;
  let realizedBuyNotional = 0; // cost basis for sold lots
  let sellCount = 0;

  for (const o of orders) {
    const side = String(o.side || '').toLowerCase();
    const amt = Number(o.amount || 0);
    const price = Number(o.price || (o.raw && (o.raw.price || o.raw.average)) || 0);
    if (!amt || amt <= 0) continue;

    if (side === 'buy') {
      buyQueue.push({ amount: amt, price });
    } else if (side === 'sell') {
      let remaining = amt;
      sellCount++;
      realizedNotionalSold += price * amt;
      while (remaining > 0 && buyQueue.length > 0) {
        const head = buyQueue[0];
        if (head.amount <= remaining + 1e-12) {
          const used = head.amount;
          realizedPnl += (price - head.price) * used;
          realizedBuyNotional += head.price * used;
          remaining -= used;
          buyQueue.shift();
        } else {
          const used = remaining;
          realizedPnl += (price - head.price) * used;
          realizedBuyNotional += head.price * used;
          head.amount -= used;
          remaining = 0;
        }
      }

      // If sells exceed buys (unmatched sell), treat unmatched sell as realized against zero-cost basis
      if (remaining > 0) {
        realizedPnl += price * remaining;
        remaining = 0;
      }
    }
  }

  return {
    realizedPnl: round(realizedPnl, 8),
    realizedNotionalSold: round(realizedNotionalSold, 8),
    realizedBuyNotional: round(realizedBuyNotional, 8),
    realizedTrades: sellCount
  };
}

function PnlController() {
  const r = Router();

  // Apply auth for all routes in this router
  r.use(authenticateUser);

  r.get('/:id/pnl', async (req, res) => {
    const botId = req.params.id;
    try {
      const bot = await botsModel.findById(botId);
      if (!bot) return res.status(404).json({ error: 'bot not found' });
      /* ⬇⬇⬇ ADD FROM HERE ⬇⬇⬇ */

      // fetch user (for exchange keys)
      // const user = await usersModel.findById(bot.user_id);
      // if (!user) {
      //   return res.status(404).json({ error: 'user not found' });
      // }
      const user = await getUserExchangeKeys(
        bot.user_id || bot.userId || bot.user,                 // user param
        bot.config?.exchangeName || bot.config?.exchange_name // exchange param directly
      );
      if (!user) {
        console.warn(`User ${bot.user_id || bot.userId} not found for bot ${botId}`);
        return;
      }
      const firstKey = user.keys[0];
      // Individual field checks with return
      if (!firstKey.exchange) {
        console.warn(`exchange missing for user ${bot.user_id || bot.userId}`);
        return;
      }

      if (!firstKey.api_key) {
        console.warn(`api_key missing for user ${bot.user_id || bot.userId}`);
        return;
      }

      if (!firstKey.api_secret) {
        console.warn(`api_secret missing for user ${bot.user_id || bot.userId}`);
        return;
      }
      // Merge values onto user so you can use user.exchange, user.api_key, user.api_secret
      user.exchange = firstKey.exchange;
      user.api_key = firstKey.api_key;
      user.api_secret = firstKey.api_secret;

      // create exchange adapter
      const adapter = new ExchangeAdapter(
        user.api_key,
        user.api_secret,
        user.exchange || 'bybit'
      );

      // fetch live market price
      let currentPrice = 0;
      try {
        const ticker = await adapter.fetchTicker(bot.pair);
        currentPrice = Number(ticker?.last || 0);
      } catch (err) {
        console.error('fetchTicker failed in pnl', err.message || err);
      }

      /* ⬆⬆⬆ ADD UNTIL HERE ⬆⬆⬆ */

      // fetch orders for bot from Postgres (FIFO requires ASC ordering)
      const q = `SELECT * FROM bot_orders WHERE bot_id = $1 ORDER BY created_at ASC`;
      const { rows } = await db.query(q, [botId]);
      const orders = rows || [];

      const pnl = computeRealizedPnlFromOrders(orders);
      // 👇 ADD THIS
      const unrealized = computeUnrealizedPnl({
        entries: bot.entries || [],
        currentPrice
      });
      const result = {
        botId,
        pair: bot.pair,
        status: bot.status,
        computedAt: new Date(),
        realized: pnl,
        unrealized,   // 👈 added here

        ordersCount: orders.length
      };

      return res.json(result);
    } catch (err) {
      console.error('pnl endpoint error', err);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  return r;
}

module.exports = { PnlController };
