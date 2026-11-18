-- AI Call Answering - a phone basket saved as a quote.
--
-- Where quote-for-shop is installed, the assistant saves the caller's basket as
-- a quote under the name and email they gave, and the quote module emails it.
-- These record which quote, so the summary email and the basket text know a
-- quote already went and do not send it a second time. Plain text, no foreign
-- key: quote-for-shop is optional and may never be installed.
ALTER TABLE "acall_baskets" ADD COLUMN IF NOT EXISTS "quote_id" TEXT;
ALTER TABLE "acall_baskets" ADD COLUMN IF NOT EXISTS "quote_number" TEXT;
ALTER TABLE "acall_baskets" ADD COLUMN IF NOT EXISTS "quote_url" TEXT;
-- Whether the quote module emailed the caller their copy.
ALTER TABLE "acall_baskets" ADD COLUMN IF NOT EXISTS "quote_emailed" BOOLEAN NOT NULL DEFAULT false;
-- Quotes saved on this call, capped so one call cannot mint a stack of them.
ALTER TABLE "acall_baskets" ADD COLUMN IF NOT EXISTS "quotes_saved" INTEGER NOT NULL DEFAULT 0;
