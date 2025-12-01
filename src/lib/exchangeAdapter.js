// // src/lib/exchangeAdapter.js
// const ccxt = require('ccxt');
// const crypto = require('crypto');
// const { computeAmountToMeetMinNotional, formatToPrecisionStr } = require('./precision');

// class ExchangeAdapter {
//   constructor(apiKey, apiSecret, exchangeId = 'bybit'){
//     this.exchangeId = exchangeId;
//     this.apiKey = apiKey;
//     this.apiSecret = apiSecret;
//     const Exch = ccxt[exchangeId];
//     if(!Exch) throw new Error(`Exchange ${exchangeId} not supported by ccxt`);
//     this.client = new Exch({
//       apiKey,
//       secret: apiSecret,
//       enableRateLimit: true,
//       timeout: 30000,
//       options: {}
//     });
//     const short = apiKey ? crypto.createHash('sha256').update(apiKey).digest('hex').slice(0,10) : 'anon';
//     this.exchangeKey = `${exchangeId}:${short}`;
//     this._marketsCache = {}; // simple in-memory cache per adapter instance
//   }

//   // Fetch and cache market info for symbol
//   async loadMarket(symbol){
//     if(this._marketsCache[symbol]) return this._marketsCache[symbol];
//     // ensure markets are loaded
//     if(!this.client.markets || Object.keys(this.client.markets).length === 0){
//       await this.client.loadMarkets();
//     }
//     const market = this.client.markets && this.client.markets[symbol] ? this.client.markets[symbol] : null;
//     this._marketsCache[symbol] = market;
//     return market;
//   }

//   async fetchTicker(symbol){
//     return this.client.fetchTicker(symbol);
//   }

//   /**
//    * createOrder with precision & minNotional enforcement
//    * - orderParams: { symbol, side, type='market', amount, price?, params? }
//    * - If `amount` does not meet minNotional, adapter will attempt to increase amount to meet minNotional (rounded to precision).
//    * - If impossible, it throws an error.
//    */
//   async createOrder({ symbol, side, type = 'market', amount, price = undefined, params = {} }){
//     if(!symbol) throw new Error('createOrder missing symbol');
//     // Load market metadata
//     const market = await this.loadMarket(symbol);

//     // If market order and no price provided, fetch ticker for estimated price to compute notional
//     let execPrice = price;
//     if(type === 'market' && (execPrice === undefined || execPrice === null)){
//       const ticker = await this.fetchTicker(symbol);
//       execPrice = ticker && ticker.last ? Number(ticker.last) : execPrice;
//     }
//     // Use last-known price if still undefined (best-effort)
//     execPrice = execPrice || 0;

//     // If amount is undefined but caller provided desiredUsd in params, compute amount from that
//     if((amount === undefined || amount === null) && params && params.desiredUsd){
//       const desiredUsd = Number(params.desiredUsd);
//       if(!execPrice || execPrice <= 0) throw new Error('Cannot compute amount from desiredUsd: unknown price');
//       amount = desiredUsd / execPrice;
//     }

//     if(!amount || amount <= 0) throw new Error('createOrder missing or invalid amount');

//     // Compute amount adjusted to market precision and minNotional
//     const adjustedAmount = computeAmountToMeetMinNotional({ desiredAmount: amount, price: execPrice, market });

//     if(adjustedAmount == null){
//       throw new Error(`Unable to compute a valid amount for ${symbol} (amount=${amount}, price=${execPrice}) according to market precision/minNotional`);
//     }

//     // If adjusted amount is greater than user's original desired amount by a lot, it's important to log/notify.
//     // We'll include the adjusted amount in params (so caller can persist/notice)
//     params = Object.assign({}, params, { __adjustedAmount: adjustedAmount });

//     // Format amount string according to precision (ccxt accepts numbers, but it's safe to format)
//     const precision = market && market.precision && market.precision.amount != null ? market.precision.amount : null;
//     const amountStr = precision != null ? formatToPrecisionStr(adjustedAmount, precision) : String(adjustedAmount);

//     // Place order using ccxt. For market orders, price arg is undefined.
//     // Use try/catch to throw informative errors
//     try{
//       // CCXT expects number or string for amount. We'll pass the number parsed from amountStr to avoid float artifacts.
//       const placed = await this.client.createOrder(symbol, type, side, Number(amountStr), type === 'market' ? undefined : price, params);
//       return placed;
//     }catch(err){
//       // If exchange rejects due to precision/minNotional, include market meta to help debugging
//       const e = new Error(`Exchange createOrder failed: ${err.message || err}. marketMeta=${JSON.stringify({ precision: market && market.precision, limits: market && market.limits })}`);
//       e.original = err;
//       throw e;
//     }
//   }

//   async fetchOHLCV(symbol, timeframe='1h', since=undefined, limit=100){
//     return this.client.fetchOHLCV(symbol, timeframe, since, limit);
//   }

//   async fetchMyTrades(symbol, since, limit=100){
//     return this.client.fetchMyTrades(symbol, since, limit);
//   }

//   async fetchBalance(){
//     return this.client.fetchBalance();
//   }
// }

// module.exports = ExchangeAdapter;
const ccxt = require('ccxt');
const crypto = require('crypto');
const { computeAmountToMeetMinNotional, formatToPrecisionStr } = require('./precision');

class ExchangeAdapter {
    constructor(apiKey, apiSecret, exchangeId = 'bybit') {
        this.exchangeId = exchangeId;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        const Exch = ccxt[exchangeId];
        if (!Exch) throw new Error(`Exchange ${exchangeId} not supported by ccxt`);

        // debug: log adapter initialization
        console.debug(`[ExchangeAdapter] init exchangeId=${exchangeId} apiKey=${apiKey ? '[REDACTED]' : 'none'}`);

        this.client = new Exch({
            apiKey,
            secret: apiSecret,
            enableRateLimit: true,
            timeout: 30000,
            options: {}
        });
        const short = apiKey ? crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 10) : 'anon';
        this.exchangeKey = `${exchangeId}:${short}`;
        this._marketsCache = {}; // simple in-memory cache per adapter instance
        console.debug(`[ExchangeAdapter] constructed exchangeKey=${this.exchangeKey}`);
    }

    // Fetch and cache market info for symbol
    async loadMarket(symbol) {
        if (this._marketsCache[symbol]) {
            console.debug(`[ExchangeAdapter] loadMarket cache hit for ${symbol}`);
            return this._marketsCache[symbol];
        }
        console.debug(`[ExchangeAdapter] loadMarket cache miss for ${symbol} - loading markets from exchange`);
        // ensure markets are loaded
        if (!this.client.markets || Object.keys(this.client.markets).length === 0) {
            console.debug(`[ExchangeAdapter] loadMarket calling client.loadMarkets()`);
            await this.client.loadMarkets();
            console.debug(`[ExchangeAdapter] loadMarket loaded ${Object.keys(this.client.markets || {}).length} markets`);
        }
        const market = this.client.markets && this.client.markets[symbol] ? this.client.markets[symbol] : null;
        if (!market) {
            console.debug(`[ExchangeAdapter] loadMarket no market metadata found for ${symbol}`);
        } else {
            console.debug(`[ExchangeAdapter] loadMarket loaded metadata for ${symbol}: precision=${market.precision ? JSON.stringify(market.precision) : 'none'} limits=${market.limits ? JSON.stringify(market.limits) : 'none'}`);
        }
        this._marketsCache[symbol] = market;
        return market;
    }

    async fetchTicker(symbol) {
        console.debug(`[ExchangeAdapter] fetchTicker request for ${symbol}`);
        try {
            const t = await this.client.fetchTicker(symbol);
            console.debug(`[ExchangeAdapter] fetchTicker ${symbol} -> ${t && t.last ? t.last : JSON.stringify(t)}`);
            return t;
        } catch (err) {
            console.debug(`[ExchangeAdapter] fetchTicker error for ${symbol}: ${err && err.message ? err.message : err}`);
            throw err;
        }
    }

    /**
     * createOrder with precision & minNotional enforcement
     * - orderParams: { symbol, side, type='market', amount, price?, params? }
     * - If `amount` does not meet minNotional, adapter will attempt to increase amount to meet minNotional (rounded to precision).
     * - If impossible, it throws an error.
     */
    //   async createOrder({ symbol, side, type = 'market', amount, price = undefined, params = {} }){
    //     if(!symbol) throw new Error('createOrder missing symbol');
    //     console.debug(`[ExchangeAdapter] createOrder start symbol=${symbol} side=${side} type=${type} amount=${amount} price=${price} params=${JSON.stringify(params || {})}`);

    //     // Load market metadata
    //     const market = await this.loadMarket(symbol);

    //     // If market order and no price provided, fetch ticker for estimated price to compute notional
    //     let execPrice = price;
    //     if(type === 'market' && (execPrice === undefined || execPrice === null)){
    //       console.debug('[ExchangeAdapter] createOrder market order without explicit price - fetching ticker to estimate price');
    //       const ticker = await this.fetchTicker(symbol);
    //       execPrice = ticker && ticker.last ? Number(ticker.last) : execPrice;
    //       console.debug(`[ExchangeAdapter] createOrder estimated execPrice=${execPrice}`);
    //     }
    //     // Use last-known price if still undefined (best-effort)
    //     execPrice = execPrice || 0;

    //     // If amount is undefined but caller provided desiredUsd in params, compute amount from that
    //     if((amount === undefined || amount === null) && params && params.desiredUsd){
    //       const desiredUsd = Number(params.desiredUsd);
    //       console.debug(`[ExchangeAdapter] createOrder desiredUsd provided=${desiredUsd}`);
    //       if(!execPrice || execPrice <= 0) throw new Error('Cannot compute amount from desiredUsd: unknown price');
    //       amount = desiredUsd / execPrice;
    //       console.debug(`[ExchangeAdapter] createOrder computed amount=${amount} from desiredUsd`);
    //     }

    //     if(!amount || amount <= 0) throw new Error('createOrder missing or invalid amount');

    //     // Compute amount adjusted to market precision and minNotional
    //     console.debug(`[ExchangeAdapter] createOrder computing adjusted amount for desiredAmount=${amount} price=${execPrice}`);
    //     const adjustedAmount = computeAmountToMeetMinNotional({ desiredAmount: amount, price: execPrice, market });
    //     console.debug(`[ExchangeAdapter] createOrder computeAmountToMeetMinNotional returned ${adjustedAmount}`);

    //     if(adjustedAmount == null){
    //       const msg = `Unable to compute a valid amount for ${symbol} (amount=${amount}, price=${execPrice}) according to market precision/minNotional`;
    //       console.debug(`[ExchangeAdapter] createOrder error: ${msg}`);
    //       throw new Error(msg);
    //     }

    //     // If adjusted amount is greater than user's original desired amount by a lot, it's important to log/notify.
    //     // We'll include the adjusted amount in params (so caller can persist/notice)
    //     params = Object.assign({}, params, { __adjustedAmount: adjustedAmount });
    //     if(adjustedAmount !== amount){
    //       console.debug(`[ExchangeAdapter] createOrder adjusted amount changed from ${amount} -> ${adjustedAmount}. Adding __adjustedAmount to params`);
    //     }

    //     // Format amount string according to precision (ccxt accepts numbers, but it's safe to format)
    //     const precision = market && market.precision && market.precision.amount != null ? market.precision.amount : null;
    //     const amountStr = precision != null ? formatToPrecisionStr(adjustedAmount, precision) : String(adjustedAmount);
    //     console.debug(`[ExchangeAdapter] createOrder final amountStr=${amountStr} precision=${precision}`);

    //     // Place order using ccxt. For market orders, price arg is undefined.
    //     // Use try/catch to throw informative errors
    //     try{
    //       console.debug(`[ExchangeAdapter] createOrder placing order on exchange: symbol=${symbol} type=${type} side=${side} amount=${amountStr} price=${type === 'market' ? 'market' : price} params=${JSON.stringify(params)}`);
    //       // CCXT expects number or string for amount. We'll pass the number parsed from amountStr to avoid float artifacts.
    //       const placed = await this.client.createOrder(symbol, type, side, Number(amountStr), type === 'market' ? undefined : price, params);
    //       console.debug(`[ExchangeAdapter] createOrder placed order id=${placed && placed.id ? placed.id : 'unknown'} result=${JSON.stringify(placed)}`);
    //       return placed;
    //     }catch(err){
    //       // If exchange rejects due to precision/minNotional, include market meta to help debugging
    //       console.debug(`[ExchangeAdapter] createOrder exchange error: ${err && err.message ? err.message : err}. marketMeta precision=${market && market.precision ? JSON.stringify(market.precision) : 'none'} limits=${market && market.limits ? JSON.stringify(market.limits) : 'none'}`);
    //       const e = new Error(`Exchange createOrder failed: ${err.message || err}. marketMeta=${JSON.stringify({ precision: market && market.precision, limits: market && market.limits })}`);
    //       e.original = err;
    //       throw e;
    //     }
    //   }
    async createOrder({ symbol, side, type = 'market', amount, price = undefined, params = {} }) {
        if (!symbol) throw new Error('createOrder missing symbol');
        console.debug(`[ExchangeAdapter] createOrder start symbol=${symbol} side=${side} type=${type} amount=${amount} price=${price} params=${JSON.stringify(params || {})}`);

        // Load market metadata
        const market = await this.loadMarket(symbol);

        // Determine whether CCXT requires a price for market buys.
        // Many exchanges (via CCXT) require a price argument to compute cost for market buys.
        const isMarketBuy = type === 'market' && String(side).toLowerCase() === 'buy';
        const ccxtRequiresPriceForMarketBuy = isMarketBuy && (this.client.options && this.client.options.createMarketBuyOrderRequiresPrice !== false);

        // If price argument not provided and it's a market order, we will estimate execPrice
        let execPrice = price;
        if (type === 'market' && (execPrice === undefined || execPrice === null)) {
            console.debug('[ExchangeAdapter] createOrder market order without explicit price - fetching ticker to estimate price');
            // Try fetchTicker, fallback to order book
            try {
                const ticker = await this.fetchTicker(symbol);
                execPrice = ticker && (ticker.ask || ticker.last || ticker.bid) ? Number(ticker.ask ?? ticker.last ?? ticker.bid) : execPrice;
                console.debug(`[ExchangeAdapter] createOrder fetched ticker price => ${execPrice}`);
            } catch (errTicker) {
                console.debug(`[ExchangeAdapter] fetchTicker failed: ${errTicker && errTicker.message ? errTicker.message : errTicker}`);
                // fallback: try order book
                try {
                    const ob = await this.fetchOrderBook(symbol, 5);
                    const bestAsk = ob.asks && ob.asks.length ? ob.asks[0][0] : undefined;
                    const bestBid = ob.bids && ob.bids.length ? ob.bids[0][0] : undefined;
                    execPrice = Number(bestAsk ?? bestBid ?? execPrice);
                    console.debug(`[ExchangeAdapter] createOrder fallback orderbook price => ${execPrice}`);
                } catch (errOB) {
                    console.debug(`[ExchangeAdapter] fetchOrderBook also failed: ${errOB && errOB.message ? errOB.message : errOB}`);
                }
            }
        }

        // If we still don't have execPrice, set to 0 as best-effort (will be validated later)
        execPrice = execPrice || 0;

        // If amount not provided but desiredUsd given, compute amount = desiredUsd / execPrice
        if ((amount === undefined || amount === null) && params && params.desiredUsd) {
            const desiredUsd = Number(params.desiredUsd);
            console.debug(`[ExchangeAdapter] createOrder desiredUsd provided=${desiredUsd}`);
            if (!execPrice || execPrice <= 0) throw new Error('Cannot compute amount from desiredUsd: unknown price');
            amount = desiredUsd / execPrice;
            console.debug(`[ExchangeAdapter] createOrder computed amount=${amount} from desiredUsd`);
        }

        if (!amount || amount <= 0) throw new Error('createOrder missing or invalid amount');

        // Compute amount adjusted to market precision and minNotional
        console.debug(`[ExchangeAdapter] createOrder computing adjusted amount for desiredAmount=${amount} price=${execPrice}`);
        const adjustedAmount = computeAmountToMeetMinNotional({ desiredAmount: amount, price: execPrice, market });
        console.debug(`[ExchangeAdapter] createOrder computeAmountToMeetMinNotional returned ${adjustedAmount}`);

        if (adjustedAmount == null) {
            const msg = `Unable to compute a valid amount for ${symbol} (amount=${amount}, price=${execPrice}) according to market precision/minNotional`;
            console.debug(`[ExchangeAdapter] createOrder error: ${msg}`);
            throw new Error(msg);
        }

        // Add adjusted amount info to params so callers can inspect
        params = Object.assign({}, params, { __adjustedAmount: adjustedAmount });
        if (adjustedAmount !== amount) {
            console.debug(`[ExchangeAdapter] createOrder adjusted amount changed from ${amount} -> ${adjustedAmount}. Adding __adjustedAmount to params`);
        }

        // Format final amount according to market precision
        const amountPrecision = market && market.precision && market.precision.amount != null ? market.precision.amount : null;
        const amountStr = amountPrecision != null ? formatToPrecisionStr(adjustedAmount, amountPrecision) : String(adjustedAmount);
        console.debug(`[ExchangeAdapter] createOrder final amountStr=${amountStr} precision=${amountPrecision}`);

        // If CCXT requires a price for market buy, ensure we have a valid price and format it
        let priceArg = undefined;
        if (type === 'market' && ccxtRequiresPriceForMarketBuy) {
            // Use execPrice (from ticker/orderbook/fallback)
            if (!execPrice || execPrice <= 0) {
                throw new Error('createOrder cannot supply price for market buy: unable to determine a valid market price');
            }

            // Round price to market precision if available
            const pricePrecision = market && market.precision && market.precision.price != null ? market.precision.price : null;
            if (pricePrecision != null) {
                // safe rounding: floor to precision to avoid going under step
                const factor = Math.pow(10, pricePrecision);
                priceArg = Math.floor(Number(execPrice) * factor) / factor;
            } else {
                priceArg = Number(execPrice);
            }

            // optional: apply a tiny slippage buffer so the cost estimate errs on the conservative side
            // e.g., for a buy we might add 0.1% to price to ensure cost >= expected. Comment out if undesirable.
            if (!params.__disableSlippageBuffer) {
                const slippagePct = typeof params.__slippagePct === 'number' ? params.__slippagePct : 0.001; // default 0.1%
                priceArg = Number(priceArg) * (1 + slippagePct);
                // re-round after buffer
                if (pricePrecision != null) {
                    const factor = Math.pow(10, pricePrecision);
                    priceArg = Math.floor(priceArg * factor) / factor;
                }
            }

            console.debug(`[ExchangeAdapter] createOrder supplying priceArg=${priceArg} for market buy (ccxt requires price)`);
        } else {
            // For limit orders or market sells or when ccxt option disabled, preserve given 'price' for limit, undefined for market
            priceArg = type === 'market' ? undefined : price;
        }

        // Place order using ccxt. For market buys we might pass priceArg to satisfy CCXT.
        try {
                let placed;  // <-- define here

            console.debug(`[ExchangeAdapter] createOrder placing order on exchange: symbol=${symbol} type=${type} side=${side} amount=${amountStr} price=${priceArg === undefined ? 'market' : priceArg} params=${JSON.stringify(params)}`);
            if (side === 'buy') {
                console.debug(`[ExchangeAdapter] buy is excuted`);

                 placed = await this.client.createOrder(symbol, type, side, Number(amountStr), priceArg, params);
            }
            else {
                // const placed = await this.client.createOrder(symbol, type, side, Number(amountStr), priceArg, params);
                 placed = await this.client.createOrder(symbol, type, side, Number(amountStr) * 0.96 , type === 'market' ? undefined : price, params);

                console.debug(`[ExchangeAdapter] sell is excuted`);


            }
            console.debug(`[ExchangeAdapter] createOrder placed order id=${placed && placed.id ? placed.id : 'unknown'} result=${JSON.stringify(placed)}`);
            return placed;
        } catch (err) {
            // If exchange rejects due to precision/minNotional, include market meta to help debugging
            console.debug(`[ExchangeAdapter] createOrder exchange error: ${err && err.message ? err.message : err}. marketMeta precision=${market && market.precision ? JSON.stringify(market.precision) : 'none'} limits=${market && market.limits ? JSON.stringify(market.limits) : 'none'}`);
            const e = new Error(`Exchange createOrder failed: ${err && err.message ? err.message : err}. marketMeta=${JSON.stringify({ precision: market && market.precision, limits: market && market.limits })}`);
            e.original = err;
            throw e;
        }
    }

    async fetchOHLCV(symbol, timeframe = '1h', since = undefined, limit = 100) {
        console.debug(`[ExchangeAdapter] fetchOHLCV symbol=${symbol} timeframe=${timeframe} since=${since} limit=${limit}`);
        try {
            const data = await this.client.fetchOHLCV(symbol, timeframe, since, limit);
            console.debug(`[ExchangeAdapter] fetchOHLCV returned ${Array.isArray(data) ? data.length : 'unknown'} rows`);
            return data;
        } catch (err) {
            console.debug(`[ExchangeAdapter] fetchOHLCV error for ${symbol}: ${err && err.message ? err.message : err}`);
            throw err;
        }
    }

    async fetchMyTrades(symbol, since, limit = 100) {
        console.debug(`[ExchangeAdapter] fetchMyTrades symbol=${symbol} since=${since} limit=${limit}`);
        try {
            const trades = await this.client.fetchMyTrades(symbol, since, limit);
            console.debug(`[ExchangeAdapter] fetchMyTrades returned ${Array.isArray(trades) ? trades.length : 'unknown'} trades`);
            return trades;
        } catch (err) {
            console.debug(`[ExchangeAdapter] fetchMyTrades error for ${symbol}: ${err && err.message ? err.message : err}`);
            throw err;
        }
    }

    async fetchBalance() {
        console.debug('[ExchangeAdapter] fetchBalance');
        try {
            const bal = await this.client.fetchBalance();
            console.debug(`[ExchangeAdapter] fetchBalance success: ${bal && bal.info ? JSON.stringify(bal.info) : 'balance retrieved'}`);
            return bal;
        } catch (err) {
            console.debug(`[ExchangeAdapter] fetchBalance error: ${err && err.message ? err.message : err}`);
            throw err;
        }
    }
}

module.exports = ExchangeAdapter;
