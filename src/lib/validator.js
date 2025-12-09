// src/lib/validator.js (suggested upgrade)
const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true });

const botSchema = {
  type: 'object',
  properties: {
    pair: {
      type: 'string',
      enum: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'LINK/USDT', 'ADA/USDT', 'BNB/USDT']
    },
    config: {
      type: 'object',
      properties: {
        exchangeName: {
          type: 'string',
          enum: ['bybit', 'mexc']   // ✅ user can choose one of them
        },
        portfolioUsd: { type: 'number', minimum: 1 },
        takeProfitPct: { type: 'number', minimum: 0, maximum: 100 },
        stopLossPct: { type: 'number', minimum: 0, maximum: 100 },
        maxEntries: { type: 'integer', minimum: 1, maximum: 10 },
        minOrderUsd: { type: 'number', minimum: 1 },
        maxAllocPct: { type: 'number', minimum: 1, maximum: 100 },
        perBuyPct: { type: 'number', minimum: 0.1, maximum: 100 },
        metrics: { type: 'object' } // optional precomputed metrics
      },
      required: ['exchangeName'],   // 👈 make it mandatory

      additionalProperties: true
    }
  },

  required: ['pair', 'config'],
  additionalProperties: false
};

const validateBot = ajv.compile(botSchema);

module.exports = {
  validateBotPayload: (o) => validateBot(o),
  validateBotSchema: botSchema
};
