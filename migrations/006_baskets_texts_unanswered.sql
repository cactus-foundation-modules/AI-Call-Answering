-- AI Call Answering - baskets built on the phone, texts to the caller, and the
-- questions the assistant could not answer.

-- ---------------------------------------------------------------------------
-- A basket the assistant put together during a call. The caller is texted (or
-- emailed) a link carrying the token; opening it copies the lines into that
-- browser's own basket, exactly as an abandoned-basket reminder does, and
-- redirects to the basket page. Lines only, in the shop's own basket shape
-- ({productId, quantity}): nothing about the caller is kept here, so a
-- forwarded link reveals product names and nothing else.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "acall_baskets" (
    "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "call_id"    TEXT         NOT NULL,
    -- Random, url-safe, unguessable. The link's only key.
    "token"      TEXT         NOT NULL,
    "lines"      JSONB        NOT NULL DEFAULT '[]'::jsonb,
    "opened_at"  TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "acall_baskets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "acall_baskets_call_fkey" FOREIGN KEY ("call_id") REFERENCES "acall_calls"("id") ON DELETE CASCADE
);
-- One basket per call: building it again replaces the lines, keeps the link.
CREATE UNIQUE INDEX IF NOT EXISTS "acall_baskets_call_id_key" ON "acall_baskets" ("call_id");
CREATE UNIQUE INDEX IF NOT EXISTS "acall_baskets_token_key" ON "acall_baskets" ("token");
CREATE INDEX IF NOT EXISTS "acall_baskets_created_at_idx" ON "acall_baskets" ("created_at");

-- Texts sent to the caller on this call, capped like emails_sent.
ALTER TABLE "acall_calls" ADD COLUMN IF NOT EXISTS "texts_sent" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Questions the assistant could not answer from its tools. Written when it
-- says so (the note_unanswered tool), and from the transcript after the call
-- for any "I can't see that" it said without noting it. Read back as a weekly
-- list: which FAQ, page or tool to add next.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "acall_unanswered" (
    "id"          TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "call_id"     TEXT         NOT NULL,
    -- What the caller wanted to know, in a few plain words.
    "question"    TEXT         NOT NULL,
    -- tool | transcript
    "source"      TEXT         NOT NULL DEFAULT 'tool',
    "topic"       TEXT         NOT NULL DEFAULT '',
    "resolved_at" TIMESTAMP(3),
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "acall_unanswered_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "acall_unanswered_call_fkey" FOREIGN KEY ("call_id") REFERENCES "acall_calls"("id") ON DELETE CASCADE,
    CONSTRAINT "acall_unanswered_source_check" CHECK ("source" IN ('tool', 'transcript'))
);
CREATE INDEX IF NOT EXISTS "acall_unanswered_created_at_idx" ON "acall_unanswered" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "acall_unanswered_call_id_idx" ON "acall_unanswered" ("call_id");
