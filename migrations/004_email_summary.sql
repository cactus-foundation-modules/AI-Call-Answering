-- AI Call Answering - emailing the caller what was discussed.
-- The signature is the assistant's own sign-off on those emails. The two call
-- columns cap how many the assistant may send on one call and remember where
-- the last went, so the call's overview can say so.
ALTER TABLE "acall_settings" ADD COLUMN IF NOT EXISTS "email_signature" TEXT NOT NULL DEFAULT '';
ALTER TABLE "acall_calls" ADD COLUMN IF NOT EXISTS "emails_sent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "acall_calls" ADD COLUMN IF NOT EXISTS "emailed_to" TEXT NOT NULL DEFAULT '';
