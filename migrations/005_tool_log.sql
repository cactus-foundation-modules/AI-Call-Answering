-- AI Call Answering - what the assistant looked up during a call.
-- The transcript holds only what was said, so a wrong answer could not be traced
-- to a tool that returned nothing, a tool that was never called, or a model that
-- ignored what it was given. One entry per tool call, appended by the tool route:
-- {tool, at, ms, input, result, failed}. Order details are reduced to the outcome
-- before they are written (lib/tool-log.ts).
ALTER TABLE "acall_calls" ADD COLUMN IF NOT EXISTS "tool_log" JSONB NOT NULL DEFAULT '[]'::jsonb;
