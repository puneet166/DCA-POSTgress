// src/worker/queue.js
const { Queue } = require('bullmq');
const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '../../.env')
});
const IORedis = require('ioredis');
const connection = new IORedis(process.env.REDIS_URL || 'redis://redis:6379');

const botQueue = new Queue('bots', { connection });

const DEFAULT_TICK_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: false,
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 500 // ms
  }
};

/**
 * enqueueBotCreate(bot)
 * - bot is expected to be the Postgres row object created by botsModel.createBot()
 * - uses bot.id (UUID) instead of Mongo's _id
 */
async function enqueueBotCreate(bot){
  // start-bot is a lightweight job to set status -> running and schedule first tick
  // note: job payload keeps the same shape { botId }
  await botQueue.add('start-bot', { botId: bot.id }, { removeOnComplete: true, attempts: 3 });
}
// helper: getJob with timeout
function getJobWithTimeout(queue, jobId, ms = 3000) {
  return Promise.race([
    queue.getJob(jobId),
    new Promise((_, reject) => setTimeout(() => reject(new Error('getJob timeout')), ms))
  ]);
}
/**
 * enqueueBotTick(botId)
 * - idempotent: uses jobId `tick:<botId>` so only one tick job exists per bot at a time.
 * - if another process created the job concurrently, returns the existing job instead of failing.
 */
async function enqueueBotTick(botId){
  const jobId = `tick:${botId}`;

  // quick check (avoids unnecessary add calls)
  const existing = await botQueue.getJob(jobId);
  if (existing) return existing;

  // Try to add; if another process added the job concurrently, handle that gracefully
  try {
    return await botQueue.add('bot-tick', { botId }, Object.assign({ jobId }, DEFAULT_TICK_OPTIONS));
  } catch (err) {
    // BullMQ throws if a job with same jobId already exists.
    // Detect that case and return the existing job instead of treating it as fatal.
    const msg = err && err.message ? err.message : '';
    if (msg.includes('Job with the given id already exists') || msg.includes('a job with the given id already exists') || msg.includes('Job already exists')) {
      // another process created it between getJob and add
      return await botQueue.getJob(jobId);
    }
    // rethrow for other errors
    throw err;
  }
}

// src/worker/queue.js (add)
// async function enqueueBotDelete(botId) {
//   const jobId = `delete:${botId}`;
//   const existing = await botQueue.getJob(jobId);
//   console.log("--------------queue1")

//   if (existing) return existing;
//   console.log("--------------queue2")
//   const opts = { removeOnComplete: true, removeOnFail: false, attempts: 3, backoff: { type: 'exponential', delay: 1000 } };
//   return await botQueue.add('delete-bot', { botId }, Object.assign({ jobId }, opts));
// }

async function enqueueBotDelete(botId) {
  const jobId = `delete:${botId}`;
  console.log('enqueueBotDelete: jobId=', jobId, 'redisStatus=', connection.status);

  // Try to get existing job but protect with timeout & try/catch so we never hang
  let existing = null;
  try {
    existing = await getJobWithTimeout(botQueue, jobId, Number(process.env.QUEUE_GETJOB_TIMEOUT_MS || 3000));
  } catch (err) {
    // If getJob times out or errors, log it and continue trying to add (idempotency handled by add error handling)
    console.warn('enqueueBotDelete: getJob failed or timed out:', err && err.message ? err.message : err);
  }

  console.log('--------------queue1 (after getJob) existing=', !!existing);
  if (existing) return existing;
  console.log('--------------queue2 (about to add job)');

  const opts = {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }
  };

  try {
    return await botQueue.add('delete-bot', { botId }, Object.assign({ jobId }, opts));
  } catch (err) {
    const msg = err && err.message ? err.message : '';
    console.warn('enqueueBotDelete: add() failed:', msg);
    if (msg.includes('Job with the given id already exists') || msg.includes('Job already exists')) {
      try {
        return await botQueue.getJob(jobId);
      } catch (err2) {
        console.error('enqueueBotDelete: getJob after add conflict failed:', err2 && err2.message ? err2.message : err2);
        throw err; // rethrow original add error if we can't recover
      }
    }
    throw err;
  }
}
module.exports = { botQueue, enqueueBotCreate, enqueueBotTick, connection,enqueueBotDelete };
