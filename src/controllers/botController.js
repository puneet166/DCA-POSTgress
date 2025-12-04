const { Router } = require('express');
const { validateBotPayload } = require('../lib/validator');
const { enqueueBotCreate, enqueueBotTick, botQueue, enqueueBotDelete } = require('../worker/queue');
const { logBot } = require('../lib/botLogger');
const { v4: uuidv4 } = require('uuid');

const botOrdersModel = require('../models/botOrders');

const authenticateAndCheckSubscription = require('../middleware/authProxy');
const checkSubscription = require("../services/subscriptionService");
const validateBotCreationRules =require("../services/validateBotCreationRule")
const botsModel = require('../models/bots');

function BotController() {
  const r = Router();

  // Apply auth for all routes in this router
  r.use(authenticateAndCheckSubscription);

  // Create bot
  r.post('/', async (req, res) => {
    const payload = req.body;

  // Now you can use req.userId instead of payload.userId for security
   if (!validateBotPayload(payload)) return res.status(400).json({ error: 'invalid payload' });
   
    const userId = req.userId;

  // Subscription check ONLY for bot creation endpoint
  const subscriptionDetail = await checkSubscription(userId);
  // if (!subscriptionDetail.subscriptionActive) {
  //   return res.status(403).json({ error: "You have no active plan to create Bot" });
  // }
  const planName = subscriptionDetail.subscription.planName
   const ruleCheck = await validateBotCreationRules({
    userId,
    planName,
    activeSub:subscriptionDetail.subscriptionActive,
    value: { pair: payload.pair }
  });

  if (!ruleCheck.success) {
    return res.status(ruleCheck.status).json({ error: ruleCheck.message });
  }
    const id = uuidv4();
    const bot = {
      id,
      userId: userId,
      pair: payload.pair,
      config: payload.config,
      status: 'created',
      createdAt: new Date(),
      entries: []
    };
    try {
      const created = await botsModel.createBot({
        id,
        userId: bot.userId,
        pair: bot.pair,
        config: bot.config,
        status: bot.status,
        entries: bot.entries
      });

      await enqueueBotCreate(created);
      try {
        await logBot(id, 'bot_created', 'info', { userId: payload.userId, pair: payload.pair });
      } catch (err) {
        console.warn('Failed to write bot_created log', err);
      }
      res.json({ id });
    } catch (err) {
      console.error('create bot failed', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Get bot by id
  r.get('/:id', async (req, res) => {
    try {
      const bot = await botsModel.findById(req.params.id);
      if (!bot) {
      return res.status(404).json({
       statusCode: 404,
       status: false,
       message: "Bot not found"
      });
     }
      res.json(bot);
    } catch (err) {
      console.error('get bot error', err);
      res.status(500).send('internal error');
    }
  });

    // Get all orders for a bot (executed by this bot)
  // GET /api/bots/:id/orders?limit=100&side=buy|sell
  r.get('/:id/orders', async (req, res) => {
    const botId = req.params.id;
    const limit = Number(req.query.limit || 100);
    const side = req.query.side ? String(req.query.side).toLowerCase() : undefined;

    try {
      // ensure bot exists (optional but nicer error)
      const bot = await botsModel.findById(botId);
      if (!bot) return res.status(404).json({ error: 'bot not found' });

      const orders = await botOrdersModel.listByBot(botId, { limit, side });
      // You can map / sanitize here if you want to hide raw payload,
      // but for now we return full records so frontend can decide.
      return res.json(orders);
    } catch (err) {
      console.error('list bot orders error', err);
      return res.status(500).json({ error: 'internal error' });
    }
  });


  // List bots
  r.get('/', async (req, res) => {
       const userId = req.userId;
    try {
      const bots = await botsModel.findAll({userId:userId});
      if (bots.length==0) return res.status(404).json({
       statusCode: 404,
       status: false,
       message: "Bot not found"
      });
      res.json(bots);
    } catch (err) {
      console.error('list bots error', err);
      res.status(500).send('internal error');
    }
  });

  // Partial update (config)
  r.patch('/:id', async (req, res) => {
    try {
      const update = {};
      if (req.body.config) update.config = req.body.config;
      if (Object.keys(update).length === 0) return res.status(400).json({ error: 'nothing to update' });
      const bot = await botsModel.updatePartial(req.params.id, update);
      if (!bot) return res.status(404).json({
       statusCode: 404,
       status: false,
       message: "Not found"
      });
      res.json(bot);
    } catch (err) {
      console.error('patch bot error', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // START a bot manually
  r.post('/:id/start', async (req, res) => {
    try {
      const bot = await botsModel.findById(req.params.id);

      if (!bot) return res.status(404).json({
       statusCode: 404,
       status: false,
       message: "Bot not found"
      });
      // console.log("-------------line no 93---------", bot.status)
      if (bot.status === 'deleted') {
        return res.status(400).json({
          error: "This bot has been deleted and cannot be restarted."
        });
      }
      if (bot.status === 'running') {
      return res.status(400).json({
       statusCode: 400,
       status: false,
       message: "This bot is already running"
      });
       
      }
      await botsModel.setStatus(req.params.id, 'running');

      // enqueue first tick
      await enqueueBotTick(req.params.id);
      try {
        await logBot(req.params.id, 'bot_started', 'info', { by: 'manual', userId: bot.user_id || bot.user_id, pair: bot.pair });
      } catch (err) {
        console.warn('Failed to write bot_started log', err);
      }
      res.json({ ok: true, message: "Bot started" });
    } catch (err) {
      console.error('start bot error', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  r.delete('/:id', async (req, res) => {
    const botId = req.params.id;
    const bot = await botsModel.findById(botId);
    if (!bot) 
      return res.status(404).json({
       statusCode: 404,
       status: false,
       message: "not found'"
      });
      
    if (bot.status === 'deleted' ||bot.status === 'deleting' ) {
      return res.status(400).json({
       statusCode: 400,
       status: false,
       message: "This bot is already deleted"
      });
      
    }
    try {
      await enqueueBotDelete(botId);
      // mark as in-progress so UI knows
      await botsModel.updatePartial(botId, { status: 'deleting', updated_at: new Date() });
      return res.status(202).json({ ok: true, message: 'Delete job enqueued' });
    } catch (err) {
      console.error('enqueue delete failed', err);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // STOP / close a bot manually
  r.post('/:id/stop', async (req, res) => {
    try {
      const bot = await botsModel.findById(req.params.id);
      if (!bot) 
        return res.status(404).json({
       statusCode: 404,
       status: false,
       message: "not found'"
      });
        
   if (bot.status === 'deleted') {

    return res.status(400).json({
       statusCode: 400,
       status: false,
       message: "This bot has been deleted and cannot be stop."
      });
      }
      if (bot.status !== 'running') {
      return res.status(400).json({
       statusCode: 400,
       status: false,
       message: "This bot is already stopped"
      });

      }
      await botsModel.setClosed(req.params.id);

      // Try to remove pending tick job for this bot (jobId: `tick:<botId>`)
      const jobId = `tick:${req.params.id}`;
      try {
        await botQueue.remove(jobId);
        console.log(`Removed queued tick job ${jobId}`);
      } catch (err) {
        console.warn(`Failed to remove queued job ${jobId} (it may not exist)`, err);
      }

      try {
        await logBot(req.params.id, 'bot_stopped', 'info', { by: 'manual', userId: bot.user_id || bot.user_id, pair: bot.pair });
      } catch (err) {
        console.warn('Failed to write bot_stopped log', err);
      }
      res.json({ ok: true, message: "Bot stopped" });
    } catch (err) {
      console.error('stop bot error', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  return r;
}

module.exports = { BotController };
