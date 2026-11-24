-- AI Call Answering - end a call once the line has been silent for a while.
--
-- A GPT-Live call with nobody on the other end ran to the full time limit and
-- was paid for by the minute. This is how many seconds of silence the
-- assistant allows before it says goodbye and hangs up, on both engines
-- (ElevenLabs had it fixed at 25). 0 switches it off.
-- Idempotent, so a fresh install (which runs 001-009 first) and an existing one
-- both end up the same.
ALTER TABLE "acall_settings" ADD COLUMN IF NOT EXISTS "silence_hang_up_seconds" INTEGER NOT NULL DEFAULT 30;
