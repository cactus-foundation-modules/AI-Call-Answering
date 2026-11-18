-- AI Call Answering - a typing sound on GPT-Live calls while a question is
-- being looked up, as ElevenLabs calls already have.
--
-- Off by default. Switched on, a GPT-Live call is put through a Twilio
-- conference instead of a straight SIP connection, so a quiet keyboard loop can
-- be played to the caller alone while the thinking model works.
-- Idempotent, so a fresh install (which runs 001-007 first) and an existing one
-- both end up the same.
ALTER TABLE "acall_settings" ADD COLUMN IF NOT EXISTS "live_typing_sound" BOOLEAN NOT NULL DEFAULT false;
