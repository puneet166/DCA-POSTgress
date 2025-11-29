/**
 * Distributed lock util (Redis)
 *
 * - Acquire: SET key value NX PX ttl
 * - Release: atomic Lua script that deletes only if value matches
 * - Renew: atomic Lua script to pexpire only if value matches
 *
 * Usage example:
 * ```js
 * const lock = new RedisLock(redisClient);
 * const token = await lock.acquire('bot-lock:123', 30000, 5000); // waits up to 5s
 * if (!token) {
 *   // failed to acquire
 * }
 * try {
 *   // do your work here
 * } finally {
 *   await lock.release('bot-lock:123', token);
 * }
 * ```
 */

const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '../../.env')
});
const IORedis = require('ioredis');
const { v4: uuidv4 } = require('uuid');

class RedisLock {
  /**
   * @param {IORedis.Redis} redisClient optional - if not passed will create its own
   */
  constructor(redisClient){
    this.redis = redisClient || new IORedis(process.env.REDIS_URL || 'redis://redis:6379');
    // Lua script for safe release: if value==arg then del else 0
    this.unlockScript = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    // Lua for renew: if value==arg then pexpire else 0
    this.renewScript = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
  }

  /**
   * Acquire lock with waiting retry/backoff.
   * @param {string} key
   * @param {number} ttlMs lock TTL in ms
   * @param {number} waitMs how long to wait total to acquire before giving up
   * @param {number} retryDelayMs initial retry delay (in ms)
   * @returns {string|null} token string (caller must keep) or null on timeout
   */
  async acquire(key, ttlMs = 30000, waitMs = 5000, retryDelayMs = 100){
    const token = uuidv4();
    const start = Date.now();
    while(true){
      // NX, PX
      const res = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
      if(res === 'OK'){
        return token;
      }
      if(Date.now() - start > waitMs){
        return null;
      }
      // jittered backoff
      await new Promise(r => setTimeout(r, retryDelayMs + Math.floor(Math.random()*retryDelayMs)));
      // exponential backoff but capped (optional)
      retryDelayMs = Math.min(1000, retryDelayMs * 1.5);
    }
  }

  /**
   * Release lock only if token matches (atomic)
   * @param {string} key
   * @param {string} token
   * @returns {boolean} true if lock released, false otherwise
   */
  async release(key, token){
    try{
      const res = await this.redis.eval(this.unlockScript, 1, key, token);
      return res === 1;
    }catch(err){
      // best-effort; log upstream
      console.error('RedisLock.release error', err);
      return false;
    }
  }

  /**
   * Renew (extend TTL) only if token matches
   * @param {string} key
   * @param {string} token
   * @param {number} ttlMs
   * @returns {boolean} true if renewed
   */
  async renew(key, token, ttlMs){
    try{
      const res = await this.redis.eval(this.renewScript, 1, key, token, ttlMs);
      return res === 1;
    }catch(err){
      console.error('RedisLock.renew error', err);
      return false;
    }
  }
}

module.exports = RedisLock;
