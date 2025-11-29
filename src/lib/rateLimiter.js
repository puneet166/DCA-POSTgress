const IORedis = require('ioredis');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({
    path: path.join(__dirname, '../../.env')
});

class RateLimiter {
    constructor() {
        this.redis = new IORedis(process.env.REDIS_URL || 'redis://redis:6379');
        // capacities per exchange (adjust to actual exchange docs)
        this.capacities = {
            'bybit': 80,
            'mexc': 60
        };
        // intended refill granularity (ms)
        this.refillMs = 1000;
    }

    // build a key that is per-exchange+apiKey hash so we respect per-key limits:
    exchangeKeyFor(exchangeId, apiKey) {
        const short = apiKey ? crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 10) : 'anon';
        return `${exchangeId}:${short}`;
    }

    // helper to accept either an explicit exchangeKey string OR build from adapter later
    getKey(exchangeKey) {
        return `tokens:${exchangeKey}`;
    }

    // ensure key exists and has the desired TTL. Uses SET NX PX to avoid races.
    async ensureInit(exchangeKey, cap) {
        const key = this.getKey(exchangeKey);
        // SET key cap PX refillMs NX -> only set if not exists
        await this.redis.set(key, cap, 'PX', this.refillMs, 'NX');
    }

    /**
    * Attempt to acquire n tokens within timeoutMs.
    * Returns true if acquired, false if timed out.
    */
//     async acquire(exchangeKey, n = 1, timeoutMs = 5000) {
//         // const cap = this.capacities[exchangeKey.split(':')[0]] || 50; // first part is exchange id
//         const cap = this.capacities[exchangeKey.split(':')[0]] || 50;
// if (n > cap) {
//   console.error('[RateLimiter] requested tokens %d > cap %d for %s', n, cap, exchangeKey);
//   return false;
// }
//         const key = this.getKey(exchangeKey);
//         await this.ensureInit(exchangeKey, cap);
//         const start = Date.now();

//         // Lua: if key missing initialize to cap (ARGV[2]); if v>=n then DECRBY and return 1 else return 0
//         const lua = `local v = tonumber(redis.call('GET', KEYS[1]) or '-1'); 
// if v==-1 then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]); v=tonumber(ARGV[2]) end; 
// if v>=tonumber(ARGV[1]) then redis.call('DECRBY', KEYS[1], ARGV[1]); return 1; else return 0; end`;

//         while (true) {
//             try {
//                 const debug = await this.redis.eval("return {redis.call('GET', KEYS[1]) or '-1', redis.call('PTTL', KEYS[1])}", 1, key);
// // console.log('[RateLimiter][DEBUG] key=%s value=%s pttl=%s want=%s cap=%s', key, debug[1], debug[2], n, cap);
//                 // pass refillMs as ARGV[3] so the initial SET in lua can re-create the key with TTL
//                 const res = await this.redis.eval(lua, 1, key, n, cap, this.refillMs);
//                 if (res === 1) return true;
//             } catch (err) {
//                 // log and treat as transient failure (do not throw)
//                 console.error('[RateLimiter] redis eval error', err && err.message ? err.message : err);
//             }
//             if (Date.now() - start > timeoutMs) {
//                 return false; // timed out acquiring tokens
//             }
//             await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
//         }
//     }

async acquire(exchangeKey, n = 1, timeoutMs = 5000){
  const cap = this.capacities[exchangeKey.split(':')[0]] || 50; // first part is exchange id
  const key = this.getKey(exchangeKey);
  await this.ensureInit(exchangeKey, cap);
  const start = Date.now();

  // Lua: if key missing initialize to cap (ARGV[2]); if v>=n then DECRBY and return 1 else return 0
  const lua = `local v = tonumber(redis.call('GET', KEYS[1]) or '-1'); 
if v==-1 then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]); v=tonumber(ARGV[2]) end; 
if v>=tonumber(ARGV[1]) then redis.call('DECRBY', KEYS[1], ARGV[1]); return 1; else return 0; end`;

  while(true){
    let res = 0;
    try {
      // pass refillMs as ARGV[3] so the initial SET in lua can re-create the key with TTL
      res = await this.redis.eval(lua, 1, key, n, cap, this.refillMs);
      if(res === 1) return true;
    } catch (err) {
      // log and treat as transient failure (do not throw)
      console.error('[RateLimiter] redis eval error', err && err.message ? err.message : err);
      // continue to diagnostics/backoff below
    }

    // If we reach here, res !== 1 (failed to acquire). Inspect the key state atomically.
    try {
      const dbg = await this.redis.eval(
        "return {redis.call('GET', KEYS[1]) or '-1', redis.call('PTTL', KEYS[1])}",
        1, key
      );
      const v = dbg[0];   // '-1' (string) or number/string token value
      const pttl = dbg[1]; // -2, -1, or ms

      console.log('[RateLimiter][DEBUG] key=%s value=%s pttl=%s want=%s cap=%s', key, v, pttl, n, cap);

      // HOTFIX: if key exists but has NO TTL (pttl === -1), restore TTL in-place
      if (pttl === -1) {
        // restore expiry without changing the token count
        await this.redis.pexpire(key, this.refillMs);
        console.log('[RateLimiter] restored TTL for %s (px=%d)', key, this.refillMs);
        // tiny backoff so other consumers can see the TTL restored and avoid stomping
        await new Promise(r => setTimeout(r, 50 + Math.random()*100));
        // try again
        if(Date.now() - start > timeoutMs) return false;
        continue;
      }
    } catch (dbgErr) {
      // don't let diagnostic fail the whole loop
      console.error('[RateLimiter] debug read error', dbgErr && dbgErr.message ? dbgErr.message : dbgErr);
    }

    if(Date.now() - start > timeoutMs) {
      return false; // timed out acquiring tokens
    }
    await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
  }
}

 async release(exchangeKey, n = 1) {
  const cap = this.capacities[exchangeKey.split(':')[0]] || 50;
  const key = this.getKey(exchangeKey);

  // If key missing -> set to min(n,cap) with PX refillMs
  // Else -> INCRBY n, and if it exceeds cap, DECRBY the overflow (preserves TTL)
  const lua = `
    local v = redis.call('GET', KEYS[1]);
    if not v then
      local nv = tonumber(ARGV[1]);
      if nv > tonumber(ARGV[2]) then nv = tonumber(ARGV[2]) end;
      redis.call('SET', KEYS[1], nv, 'PX', ARGV[3]);
      return nv;
    else
      local nv = redis.call('INCRBY', KEYS[1], ARGV[1]);
      if tonumber(nv) > tonumber(ARGV[2]) then
        local overflow = tonumber(nv) - tonumber(ARGV[2]);
        redis.call('DECRBY', KEYS[1], overflow);
        nv = tonumber(ARGV[2]);
      end;
      return tonumber(nv);
    end
  `;

  try {
    const res = await this.redis.eval(lua, 1, key, n, cap, this.refillMs);
    // redis returns number/string; normalize to number
    return typeof res === 'number' ? res : parseInt(res, 10);
  } catch (err) {
    console.error('[RateLimiter] redis release error', err && err.message ? err.message : err);
    return null;
  }
}

}

module.exports = { RateLimiter };
