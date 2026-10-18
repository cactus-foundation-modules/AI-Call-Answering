-- AI Call Answering - the contact details on an order the caller has proved they own.
-- Kept so a callback request needs nothing asked twice: the name, email and phone
-- are already on the order. Never sent to the assistant, only copied onto the
-- callback by the server.
ALTER TABLE "acall_calls" ADD COLUMN IF NOT EXISTS "verified_contact_name"  TEXT NOT NULL DEFAULT '';
ALTER TABLE "acall_calls" ADD COLUMN IF NOT EXISTS "verified_contact_email" TEXT NOT NULL DEFAULT '';
ALTER TABLE "acall_calls" ADD COLUMN IF NOT EXISTS "verified_contact_phone" TEXT NOT NULL DEFAULT '';
