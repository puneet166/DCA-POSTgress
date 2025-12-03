
-- Remove the old UUID column
ALTER TABLE bots DROP COLUMN IF EXISTS user_id;

-- Add new integer column
ALTER TABLE bots ADD COLUMN user_id INTEGER NOT NULL;
