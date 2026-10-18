-- AI Call Answering - fallback ElevenLabs keys.
-- A key's credit runs out per ElevenLabs account, so a fallback is a whole
-- second account: it needs its own agent, tools and post-call webhook (with its
-- own signing secret), all made by "Set up the assistant". The bearer token the
-- tools present to this site is shared, so it stays on acall_settings.
CREATE TABLE IF NOT EXISTS "acall_fallback_keys" (
    "id"                       TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "label"                    TEXT         NOT NULL DEFAULT '',
    "api_key_encrypted"        TEXT         NOT NULL,
    -- Order of use: lowest first, after the main key.
    "position"                 INTEGER      NOT NULL DEFAULT 0,
    "agent_id"                 TEXT,
    "post_call_webhook_id"     TEXT,
    "webhook_secret_encrypted" TEXT,
    "tool_ids"                 JSONB        NOT NULL DEFAULT '{}'::jsonb,
    "synced_hash"              TEXT         NOT NULL DEFAULT '',
    "synced_at"                TIMESTAMP(3),
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "acall_fallback_keys_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "acall_fallback_keys_position_idx" ON "acall_fallback_keys" ("position", "created_at");
