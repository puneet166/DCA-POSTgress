// /**
//  * runDcaStep + checkExit
//  *
//  * - runDcaStep(bot, ticker, metrics)
//  *    decides whether to place a BUY DCA order (returns { placeOrder, orderParams, reason })
//  *
//  * - checkExit(bot, ticker)
//  *    decides whether to place a SELL order for take-profit or stop-loss
//  *    (returns { placeOrder, orderParams, reason })
//  *
//  * Notes:
//  * - This module operates only on the bot document and the provided "ticker" and "metrics".
//  * - We compute average cost using bot.entries array (each entry: {price, amount, ts})
//  */

// function pctDiff(current, from){
//   return ((current - from) / from) * 100;
// }

// function computeAvgPriceAndAmount(entries = []){
//   // entries: [{ price, amount }]
//   let totalNotional = 0;
//   let totalAmount = 0;
//   for(const e of entries){
//     const p = Number(e.price || 0);
//     const a = Number(e.amount || 0);
//     if(!p || !a) continue;
//     totalNotional += p * a;
//     totalAmount += a;
//   }
//   const avg = totalAmount > 0 ? (totalNotional / totalAmount) : 0;
//   return { avgPrice: avg, totalAmount, totalNotional };
// }

// async function runDcaStep(bot, ticker, metrics){
//   const price = ticker.last;
//   const cfg = bot.config || {};
//   const portfolioUsd = cfg.portfolioUsd || 100;
//   const takeProfitPct = cfg.takeProfitPct || 18; // unused here, for exits
//   const maxEntries = cfg.maxEntries || 3;
//   const minOrderUsd = cfg.minOrderUsd || 10;
//   const maxAllocPct = cfg.maxAllocPct || 20;
//   const perBuyPct = cfg.perBuyPct || 5;

//   // Metrics validation
//   const ema200_4h = metrics.ema200_4h;
//   const rsi_4h = metrics.rsi_4h;
//   const btc_1h = metrics.btc_1h;
//   const btc_1h_ema200 = metrics.btc_1h_ema200;

//   if(!(ema200_4h && rsi_4h !== undefined && btc_1h && btc_1h_ema200)){
//     return { placeOrder: false, reason: 'missing metrics' };
//   }

//   // Buy conditions
//   const belowEMA = price < ema200_4h;
//   const rsiOk = rsi_4h < 40;
//   const btcTrendOk = btc_1h > btc_1h_ema200;

//   if(!(belowEMA && rsiOk && btcTrendOk)) return { placeOrder: false, reason: 'conditions not met' };

//   // Entries logic
//   const existingEntries = bot.entries || [];
//   if(existingEntries.length >= maxEntries) return { placeOrder:false, reason:'max entries reached' };

//   // required drop from last entry if not first
//   if(existingEntries.length > 0){
//     const lastPrice = Number(existingEntries[existingEntries.length - 1].price);
//     const drop = pctDiff(price, lastPrice);
//     if(existingEntries.length === 1 && drop > -10) return { placeOrder:false, reason:'not dropped enough for 2nd entry' };
//     if(existingEntries.length === 2 && drop > -15) return { placeOrder:false, reason:'not dropped enough for 3rd entry' };
//   }

//   // Position sizing
//   const allocationUsd = Math.max(minOrderUsd, Math.floor(portfolioUsd * (perBuyPct / 100)));
//   const existingNotional = (existingEntries.reduce((s, e) => s + (Number(e.price || 0) * Number(e.amount || 0)), 0) || 0);
//   const totalAllocatedUsd = existingNotional + allocationUsd;
//   const maxAllocUsd = portfolioUsd * (maxAllocPct / 100);
//   if(totalAllocatedUsd > maxAllocUsd) return { placeOrder:false, reason:'exceeds max allocation' };

//   const amount = Number((allocationUsd / price).toFixed(6)); // adjust precision elsewhere
//   if(allocationUsd < minOrderUsd || amount <= 0) return { placeOrder:false, reason:'order too small' };

//   return {
//     placeOrder: true,
//     orderParams: {
//       symbol: bot.pair,
//       side: 'buy',
//       type: 'market',
//       amount
//     }
//   };
// }

// /**
//  * checkExit(bot, ticker)
//  * - determines if we should SELL full position for TP or SL
//  * - returns { placeOrder, orderParams, reason, exitType } where exitType is 'tp'|'sl'
//  */
// async function checkExit(bot, ticker){
//   const price = ticker.last;
//   const cfg = bot.config || {};
//   const takeProfitPct = cfg.takeProfitPct || 18; // % (e.g., 18)
//   const stopLossPct = cfg.stopLossPct; // optional, e.g., 12 for -12%

//   const entries = bot.entries || [];
//   if(!entries.length) return { placeOrder:false, reason:'no position' };

//   const { avgPrice, totalAmount } = computeAvgPriceAndAmount(entries);
//   if(totalAmount <= 0) return { placeOrder:false, reason:'no amount' };

//   // Current pnl in %
//   const pnlPct = pctDiff(price, avgPrice);

//   // Take profit trigger
//   if(takeProfitPct && pnlPct >= takeProfitPct){
//     // sell full position (market)
//     return {
//       placeOrder: true,
//       orderParams: {
//         symbol: bot.pair,
//         side: 'sell',
//         type: 'market',
//         amount: Number(totalAmount.toFixed(6))
//       },
//       reason: `tp reached (${pnlPct.toFixed(2)}% >= ${takeProfitPct}%)`,
//       exitType: 'tp'
//     };
//   }

//   // Stop loss
//   if(typeof stopLossPct === 'number' && pnlPct <= -Math.abs(stopLossPct)){
//     return {
//       placeOrder: true,
//       orderParams: {
//         symbol: bot.pair,
//         side: 'sell',
//         type: 'market',
//         amount: Number(totalAmount.toFixed(6))
//       },
//       reason: `sl reached (${pnlPct.toFixed(2)}% <= -${stopLossPct}%)`,
//       exitType: 'sl'
//     };
//   }

//   return { placeOrder:false, reason: 'no exit condition met' };
// }

// module.exports = { runDcaStep, checkExit, computeAvgPriceAndAmount };
function pctDiff(current, from) {
  return ((current - from) / from) * 100;
}

function computeAvgPriceAndAmount(entries = []) {
  console.debug(`[DCA] computeAvgPriceAndAmount entries=${entries.length}`);
  let totalNotional = 0;
  let totalAmount = 0;
  for (const e of entries) {
    const p = Number(e.price || 0);
    const a = Number(e.amount || 0);
    if (!p || !a) continue;
    totalNotional += p * a;
    totalAmount += a;
  }
  const avg = totalAmount > 0 ? (totalNotional / totalAmount) : 0;
  console.debug(`[DCA] computeAvgPriceAndAmount result avg=${avg} totalAmount=${totalAmount} totalNotional=${totalNotional}`);
  return { avgPrice: avg, totalAmount, totalNotional };
}

async function runDcaStep(bot, ticker, metrics) {
  console.debug(`[DCA] runDcaStep start pair=${bot.pair} price=${ticker.last}`);
  const price = ticker.last;
  const cfg = bot.config || {};
  console.debug(`[DCA] config=${JSON.stringify(cfg)}`);

  const portfolioUsd = cfg.portfolioUsd || 100;
  const takeProfitPct = cfg.takeProfitPct || 18;
  const maxEntries = cfg.maxEntries || 3;
  const minOrderUsd = cfg.minOrderUsd || 10;
  const maxAllocPct = cfg.maxAllocPct || 20;
  const perBuyPct = cfg.perBuyPct || 5;
  const enableIndicators = cfg.enableIndicators || 0;

  const ema200_4h = metrics.ema200_4h;
  const rsi_4h = metrics.rsi_4h;
  const btc_1h = metrics.btc_1h;
  const btc_1h_ema200 = metrics.btc_1h_ema200;
  // console.debug(`[DCA] metrics=${JSON.stringify(metrics)}`);

  //   if(!(ema200_4h && rsi_4h !== undefined && btc_1h && btc_1h_ema200)){
  //     console.debug(`[DCA] missing metrics`);
  //     return { placeOrder: false, reason: 'missing metrics' };
  //   }

  const belowEMA = price < ema200_4h;
  const rsiOk = rsi_4h < 40;
  const btcTrendOk = btc_1h > btc_1h_ema200;
  console.debug(`[DCA] cond belowEMA=${belowEMA} rsiOk=${rsiOk} btcTrendOk=${btcTrendOk}`);

  //   if(!(belowEMA && rsiOk && btcTrendOk)){
  //     return { placeOrder: false, reason: 'conditions not met' };
  //   }
  if (enableIndicators) {
    const failed = [];

    if (!belowEMA) failed.push('Price is above the 4H EMA200');
    if (!rsiOk) failed.push('RSI 4H is too high');
    if (!btcTrendOk) failed.push('BTC 1H is below its EMA200 (downtrend)');

    if (failed.length > 0) {
      return {
        placeOrder: false,
        reason: `DCA entry conditions not met: ${failed.join(', ')}.`
      };
    }
  }
  const existingEntries = bot.entries || [];
  console.debug(`[DCA] existing entries=${existingEntries.length}`);

  if (existingEntries.length >= maxEntries) {
    console.debug(`[DCA] max entries reached`);
    return { placeOrder: false, reason: 'max entries reached' };
  }

  if (existingEntries.length > 0) {
    const lastPrice = Number(existingEntries[existingEntries.length - 1].price);
    const drop = pctDiff(price, lastPrice);
    console.debug(`[DCA] drop from last entry=${drop}`);

    if (existingEntries.length === 1 && drop > -10) {
      return { placeOrder: false, reason: 'not dropped enough for 2nd entry' };
    }
    if (existingEntries.length === 2 && drop > -15) {
      return { placeOrder: false, reason: 'not dropped enough for 3rd entry' };
    }
  }

  const allocationUsd = Math.max(minOrderUsd, Math.floor(portfolioUsd * (perBuyPct / 100)));
  const existingNotional = (existingEntries.reduce((s, e) => s + (Number(e.price || 0) * Number(e.amount || 0)), 0) || 0);
  const totalAllocatedUsd = existingNotional + allocationUsd;
  const maxAllocUsd = portfolioUsd * (maxAllocPct / 100);
  console.debug(`[DCA] allocUsd=${allocationUsd} existingNotional=${existingNotional} totalAllocatedUsd=${totalAllocatedUsd} maxAllocUsd=${maxAllocUsd}`);

  if (totalAllocatedUsd > maxAllocUsd) {
    return { placeOrder: false, reason: 'exceeds max allocation' };
  }

  const amount = Number((allocationUsd / price).toFixed(6));
  console.debug(`[DCA] computed buy amount=${amount}`);

  if (allocationUsd < minOrderUsd || amount <= 0) {
    return { placeOrder: false, reason: 'order too small' };
  }

  console.debug(`[DCA] RUN BUY order`);
  return {
    placeOrder: true,
    orderParams: {
      symbol: bot.pair,
      side: 'buy',
      type: 'market',
      amount
    }
  };
}

async function checkExit(bot, ticker) {
  console.debug(`[DCA] checkExit start pair=${bot.pair} price=${ticker.last}`);

  const price = ticker.last;
  const cfg = bot.config || {};
  console.debug(`[DCA] exit config=${JSON.stringify(cfg)}`);

  const takeProfitPct = cfg.takeProfitPct || 18;
  const stopLossPct = cfg.stopLossPct;

  const entries = bot.entries || [];
  console.debug(`[DCA] entries=${entries.length}`);
  if (!entries.length) return { placeOrder: false, reason: 'no position' };

  const { avgPrice, totalAmount } = computeAvgPriceAndAmount(entries);
  console.debug(`[DCA] avgPrice=${avgPrice} totalAmount=${totalAmount}`);

  if (totalAmount <= 0) return { placeOrder: false, reason: 'no amount' };

  const pnlPct = pctDiff(price, avgPrice);
  console.debug(`[DCA] pnlPct=${pnlPct}`);

  if (takeProfitPct && pnlPct >= takeProfitPct) {
    console.debug(`[DCA] TAKE PROFIT triggered`);
    return {
      placeOrder: true,
      orderParams: {
        symbol: bot.pair,
        side: 'sell',
        type: 'market',
        amount: Number(totalAmount.toFixed(6))
      },
      reason: `tp reached (${pnlPct.toFixed(2)}% >= ${takeProfitPct}%)`,
      exitType: 'tp'
    };
  }

  if (typeof stopLossPct === 'number' && pnlPct <= -Math.abs(stopLossPct)) {
    console.debug(`[DCA] STOP LOSS triggered`);
    return {
      placeOrder: true,
      orderParams: {
        symbol: bot.pair,
        side: 'sell',
        type: 'market',
        amount: Number(totalAmount.toFixed(6))
      },
      reason: `sl reached (${pnlPct.toFixed(2)}% <= -${stopLossPct}%)`,
      exitType: 'sl'
    };
  }

  console.debug(`[DCA] no exit condition met`);
  return { placeOrder: false, reason: 'no exit condition met' };
}

module.exports = { runDcaStep, checkExit, computeAvgPriceAndAmount };