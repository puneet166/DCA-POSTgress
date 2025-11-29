// scripts/inspectDelete.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') }); // adjust path if needed
const IORedis = require('ioredis');
const { Queue } = require('bullmq');

const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
const botQueue = new Queue('bots', { connection });

async function main() {
  const botId = process.argv[2];
  if (!botId) {
    console.error('Usage: node scripts/inspectDelete.js <BOT_ID>');
    process.exit(1);
  }
  const jobId = `delete:${botId}`;
  try {
    const job = await botQueue.getJob(jobId);
    if (!job) {
      console.log('No job found with id', jobId);
      return;
    }

    console.log('=== JOB SUMMARY ===');
    console.log('id:', job.id);
    console.log('name:', job.name);
    console.log('data:', job.data);
    console.log('timestamp:', new Date(job.timestamp));
    console.log('attemptsMade:', job.attemptsMade);
    console.log('opts:', job.opts || {});
    console.log('state:', await job.getState().catch(e => `getState error: ${e.message}`));
    console.log('failedReason:', job.failedReason);
    console.log('returnvalue:', job.returnvalue);
    console.log('stacktrace:', Array.isArray(job.stacktrace) ? job.stacktrace.join('\n') : job.stacktrace);
    console.log('processedOn:', job.processedOn ? new Date(job.processedOn) : null);
    console.log('finishedOn:', job.finishedOn ? new Date(job.finishedOn) : null);
    console.log('=== END ===');

  } catch (err) {
    console.error('inspectDelete error', err);
  } finally {
    try { await botQueue.close(); } catch(_) {}
    try { await connection.disconnect(); } catch(_) {}
  }
}

main();
