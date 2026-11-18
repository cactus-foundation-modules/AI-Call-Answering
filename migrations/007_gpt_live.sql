-- AI Call Answering - a second voice engine: OpenAI GPT-Live.
--
-- ElevenLabs stays the default. With engine = 'gpt-live' the call is put
-- through to OpenAI's SIP address instead, OpenAI tells this site about it by
-- webhook, and the site accepts it with the same instructions and tools and
-- runs the tools over a server-side connection to the live session.
-- Idempotent, so a fresh install (which runs 001-006 first) and an existing one
-- both end up the same.

-- 'elevenlabs' | 'gpt-live'. A CHECK, unlike the model names: the code has a
-- branch per engine and an unknown one would answer nothing.
ALTER TABLE "acall_settings" ADD COLUMN IF NOT EXISTS "engine" TEXT NOT NULL DEFAULT 'elevenlabs';
-- Dropped and added again rather than a DO block: the same result on a re-run,
-- and one plain statement per line for the runner and the live SQL test.
ALTER TABLE "acall_settings" DROP CONSTRAINT IF EXISTS "acall_settings_engine_check";
ALTER TABLE "acall_settings" ADD CONSTRAINT "acall_settings_engine_check" CHECK ("engine" IN ('elevenlabs', 'gpt-live'));
-- AES-GCM ciphertext (lib/crypto/secrets). Null while OPENAI_API_KEY is set
-- on the hosting instead.
ALTER TABLE "acall_settings" ADD COLUMN IF NOT EXISTS "openai_api_key_encrypted" TEXT;
-- proj_..., the project that owns the key and the webhook. It is the user part
-- of the SIP address calls are put through to.
ALTER TABLE "acall_settings" ADD COLUMN IF NOT EXISTS "openai_project_id" TEXT NOT NULL DEFAULT '';
-- whsec_..., the signing secret of the project's webhook. Also keys the
-- signature on the call reference the site sends along with each call.
ALTER TABLE "acall_settings" ADD COLUMN IF NOT EXISTS "openai_webhook_secret_encrypted" TEXT;
-- Plain strings rather than CHECKs: OpenAI adds voices and backend models
-- often, and a site should not wait for a release to use them.
ALTER TABLE "acall_settings" ADD COLUMN IF NOT EXISTS "live_voice" TEXT NOT NULL DEFAULT 'marin';
ALTER TABLE "acall_settings" ADD COLUMN IF NOT EXISTS "live_backend_model" TEXT NOT NULL DEFAULT 'gpt-6-luna';
-- 'global' | 'eu' | 'in': which OpenAI SIP address calls go to.
ALTER TABLE "acall_settings" ADD COLUMN IF NOT EXISTS "live_region" TEXT NOT NULL DEFAULT 'global';

-- Which engine took the call, the OpenAI session it ran in, and what the
-- thinking side of it used: {"seconds": n, "inputTokens": n, "cachedTokens": n,
-- "outputTokens": n, "responses": n}. Cached tokens are how a site can see the
-- prompt cache earning its keep.
ALTER TABLE "acall_calls" ADD COLUMN IF NOT EXISTS "engine" TEXT NOT NULL DEFAULT 'elevenlabs';
ALTER TABLE "acall_calls" ADD COLUMN IF NOT EXISTS "live_session_id" TEXT;
ALTER TABLE "acall_calls" ADD COLUMN IF NOT EXISTS "usage" JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS "acall_calls_live_session_id_key" ON "acall_calls" ("live_session_id") WHERE "live_session_id" IS NOT NULL;
