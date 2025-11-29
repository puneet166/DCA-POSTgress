-- migrations/001_init_schema.sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key TEXT,
  api_secret TEXT,
  exchange TEXT DEFAULT 'bybit',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_api_key_idx ON users(api_key);

-- BOTS
CREATE TABLE IF NOT EXISTS bots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pair TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'created',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  closed_at TIMESTAMPTZ,
  entries JSONB DEFAULT '[]'::jsonb -- array of entry objects {price,amount,ts}
);

CREATE INDEX IF NOT EXISTS bots_user_id_idx ON bots(user_id);
CREATE INDEX IF NOT EXISTS bots_status_idx ON bots(status);

-- BOT LOGS
CREATE TABLE IF NOT EXISTS bot_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID REFERENCES bots(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  meta JSONB,
  ts TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_logs_botid_idx ON bot_logs(bot_id);

-- BOT ORDERS
CREATE TABLE IF NOT EXISTS bot_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID REFERENCES bots(id) ON DELETE CASCADE,
  order_id TEXT,
  side TEXT,
  amount NUMERIC,
  price NUMERIC,
  raw JSONB,
  exit_type TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_orders_botid_idx ON bot_orders(bot_id);

-- METRICS
CREATE TABLE IF NOT EXISTS metrics (
  pair TEXT PRIMARY KEY,
  last_balance_snapshot JSONB,
  ts TIMESTAMPTZ DEFAULT now()
);

-- Useful helpers: update updated_at trigger for tables that need it (bots, users)
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_timestamp_on_users ON users;
CREATE TRIGGER set_timestamp_on_users
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

DROP TRIGGER IF EXISTS set_timestamp_on_bots ON bots;
CREATE TRIGGER set_timestamp_on_bots
BEFORE UPDATE ON bots
FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
