// src/controllers/pnlController.js
// API: GET /api/bots/:id/pnl
// Returns realized P&L only (FIFO matching of buy/sell orders)

const { Router } = require('express');
const db = require('../lib/pgClient');
const botsModel = require('../models/bots');
const authenticateAndCheckSubscription = require('../middleware/authProxy');


function round(n, decimals = 8){
  if (typeof n !== 'number' || !isFinite(n)) return 0;
  const p = Math.pow(10, decimals);
  return Math.round(n * p) / p;
}

/**
 * Compute realized PnL using FIFO matching of buys -> sells
 * Orders must be ordered by time ASC to apply FIFO correctly
 */
function computeRealizedPnlFromOrders(orders){
  const buyQueue = [];// { amount, price }
  let realizedPnl = 0;
  let realizedNotionalSold = 0;
  let realizedBuyNotional = 0; // cost basis for sold lots
  let sellCount = 0;

  for(const o of orders){
    const side = String(o.side || '').toLowerCase();
    const amt = Number(o.amount || 0);
    const price = Number(o.price || (o.raw && (o.raw.price || o.raw.average)) || 0);
    if(!amt || amt <= 0) continue;

    if(side === 'buy'){
      buyQueue.push({ amount: amt, price });
    } else if(side === 'sell'){
      let remaining = amt;
      sellCount++;
      realizedNotionalSold += price * amt;
      while(remaining > 0 && buyQueue.length > 0){
        const head = buyQueue[0];
        if(head.amount <= remaining + 1e-12){
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
      if(remaining > 0){
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

function PnlController(){
  const r = Router();

   // Apply auth for all routes in this router
  r.use(authenticateAndCheckSubscription);

  r.get('/:id/pnl', async (req, res) => {
    const botId = req.params.id;
    try{
      const bot = await botsModel.findById(botId);
      if(!bot) return res.status(404).json({ error: 'bot not found' });

      // fetch orders for bot from Postgres (FIFO requires ASC ordering)
      const q = `SELECT * FROM bot_orders WHERE bot_id = $1 ORDER BY created_at ASC`;
      const { rows } = await db.query(q, [botId]);
      const orders = rows || [];

      const pnl = computeRealizedPnlFromOrders(orders);

      const result = {
        botId,
        pair: bot.pair,
        status: bot.status,
        computedAt: new Date(),
        realized: pnl,
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
