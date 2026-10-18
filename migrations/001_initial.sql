-- AI Call Answering - initial migration
-- Table prefix: acall_
-- Applied once by the Cactus module migration runner during build.

-- ---------------------------------------------------------------------------
-- Settings (singleton). The ElevenLabs agent this module provisions, the voice
-- it speaks with and the secrets that tie the two halves together.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "acall_settings" (
    "id"                      TEXT         NOT NULL DEFAULT 'singleton',
    -- Master switch. Off means every call goes to forwarding and voicemail as
    -- though this module were not installed.
    "enabled"                 BOOLEAN      NOT NULL DEFAULT false,
    -- AES-GCM ciphertext (lib/crypto/secrets). Null while the key comes from
    -- the ELEVENLABS_API_KEY env var instead.
    "api_key_encrypted"       TEXT,
    -- The ElevenLabs agent, created by "Set up the assistant". Null until then.
    "agent_id"                TEXT,
    "voice_id"                TEXT         NOT NULL DEFAULT '',
    -- A plain string rather than a CHECK: ElevenLabs names a new model every few
    -- months and a site should not wait for a release to use it.
    "tts_model"               TEXT         NOT NULL DEFAULT 'eleven_v4',
    "llm"                     TEXT         NOT NULL DEFAULT 'claude-sonnet-5-5',
    "language"                TEXT         NOT NULL DEFAULT 'en',
    "business_name"           TEXT         NOT NULL DEFAULT '',
    -- What the assistant says first. Empty = a stock line built from the name.
    "greeting"                TEXT         NOT NULL DEFAULT '',
    -- Owner's own rules, appended to the built-in instructions.
    "extra_instructions"      TEXT         NOT NULL DEFAULT '',
    "max_call_minutes"        INTEGER      NOT NULL DEFAULT 15,
    -- ElevenLabs workspace webhook that delivers the finished call, and the
    -- HMAC secret it signs with. Created by the module on first setup.
    "post_call_webhook_id"    TEXT,
    "webhook_secret_encrypted" TEXT,
    -- Bearer token the agent's tools present when they call this site.
    "tools_token_encrypted"   TEXT,
    -- {"search_products": "<tool id>", ...} - the ElevenLabs tools made for this site.
    "tool_ids"                JSONB        NOT NULL DEFAULT '{}'::jsonb,
    -- Hash of what was last pushed to ElevenLabs, so the settings screen can say
    -- "changed since the assistant was last set up".
    "synced_hash"             TEXT         NOT NULL DEFAULT '',
    "synced_at"               TIMESTAMP(3),
    "updated_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "acall_settings_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Which of the site's Twilio numbers the assistant answers.
--   always          - every call
--   when_unattended - only when the number is shut, or nothing would ring
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "acall_numbers" (
    "phone_sid"    TEXT         NOT NULL,
    "phone_number" TEXT         NOT NULL,
    "enabled"      BOOLEAN      NOT NULL DEFAULT true,
    "mode"         TEXT         NOT NULL DEFAULT 'always',
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "acall_numbers_pkey" PRIMARY KEY ("phone_sid"),
    CONSTRAINT "acall_numbers_mode_check" CHECK ("mode" IN ('always', 'when_unattended'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "acall_numbers_phone_number_key" ON "acall_numbers" ("phone_number");

-- ---------------------------------------------------------------------------
-- One row per call the assistant took. Written when the call is handed over,
-- completed when ElevenLabs delivers the transcript. This is what the unified
-- inbox reads its call overviews from.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "acall_calls" (
    "id"                 TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "call_sid"           TEXT         NOT NULL,
    "conversation_id"    TEXT,
    "from_number"        TEXT         NOT NULL DEFAULT '',
    "to_number"          TEXT         NOT NULL DEFAULT '',
    -- in_progress | completed
    "status"             TEXT         NOT NULL DEFAULT 'in_progress',
    "started_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_seconds"   INTEGER      NOT NULL DEFAULT 0,
    "summary"            TEXT         NOT NULL DEFAULT '',
    "transcript"         JSONB        NOT NULL DEFAULT '[]'::jsonb,
    -- Collected when the assistant could not help, so somebody can ring back.
    "caller_name"        TEXT         NOT NULL DEFAULT '',
    "caller_email"       TEXT         NOT NULL DEFAULT '',
    "caller_phone"       TEXT         NOT NULL DEFAULT '',
    "callback_needed"    BOOLEAN      NOT NULL DEFAULT false,
    "callback_reason"    TEXT         NOT NULL DEFAULT '',
    "handled_at"         TIMESTAMP(3),
    "read_at"            TIMESTAMP(3),
    -- Order numbers the caller proved they own during the call.
    "verified_orders"    TEXT[]       NOT NULL DEFAULT '{}',
    -- Wrong answers to an order check, for lockout. Per call.
    "failed_order_checks" INTEGER     NOT NULL DEFAULT 0,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "acall_calls_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "acall_calls_status_check" CHECK ("status" IN ('in_progress', 'completed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "acall_calls_call_sid_key" ON "acall_calls" ("call_sid");
CREATE UNIQUE INDEX IF NOT EXISTS "acall_calls_conversation_id_key" ON "acall_calls" ("conversation_id") WHERE "conversation_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "acall_calls_started_at_idx" ON "acall_calls" ("started_at" DESC, "id");
CREATE INDEX IF NOT EXISTS "acall_calls_updated_at_idx" ON "acall_calls" ("updated_at");
CREATE INDEX IF NOT EXISTS "acall_calls_from_number_idx" ON "acall_calls" ("from_number", "started_at");
