-- AI Call Answering - the products a call was about.
-- [{id, parentId}], newest last, ten at most (lib/discussed-products.ts): what
-- a note of the call lists when the model does not say which. Idempotent.
ALTER TABLE "acall_calls" ADD COLUMN IF NOT EXISTS "discussed_products" JSONB NOT NULL DEFAULT '[]'::jsonb;
