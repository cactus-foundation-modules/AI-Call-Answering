<p align="center">
  <img src="module-art.webp" alt="AI Call Answering module" width="640" />
</p>

# AI Call Answering module

A voice assistant that answers your phone. Built on the [Twilio module](https://github.com/cactus-foundation-modules/twilio) for the phone line, with a choice of two voice engines: [ElevenLabs](https://elevenlabs.io) (the default) or OpenAI's GPT-Live 1.

## What it does

- **Answers calls** on the numbers you choose, in a natural ElevenLabs voice (Eleven v4 by default), or with OpenAI GPT-Live 1, which listens while it talks so a caller can interrupt the way they would a person.
- **Answers questions about any product** in your shop: sizes, options, price, stock, specifications and your FAQs (product, category, collection and shop-wide).
- **Suggests products** from the shop based on what the caller needs and what they want to spend.
- **Handles order enquiries**, but only after checking who is calling. It needs the delivery postcode plus one of the order number, the email address or the company name. Wrong answers are limited per call and per number, and nothing like an email, phone number or street address is ever read out.
- **Explains how to pay and when the paperwork comes**: the payment methods that are switched on right now (and, for card payments, which cards and wallets are taken), when a VAT invoice is issued, and which orders get a pro-forma invoice. For a bank transfer it reads out your own bank transfer wording from the Payments tab, account name, sort code and account number included, one digit at a time, and a caller with an unpaid order hears the same wording for that order. Read live from the shop's own settings on every call, so a change on the Payments or Invoices tab reaches the phone straight away with nothing to set up again.
- **Emails the order link** to the address on the order, when a verified caller cannot find it in their confirmation email. The wording is editable under Settings > Emails, and the address it leaves from is chosen on the Assistant tab (needs the Unified Inbox module).
- **Builds a basket on the phone.** A caller with a list, one chair or eighty lines, gets a basket made of the exact variations they chose and a link to it. Opening the link on any phone or computer puts the lines in that browser's basket, ready to check out. The link carries product names and quantities only, never who called.
- **Texts instead of emailing.** The basket link, the order page link or a short note of the call goes by text to the number the caller rang from (never a number said aloud), through the Twilio module's default text number. Landlines and withheld numbers are offered email instead. Capped per call and per hour.
- **Remembers earlier contact.** On "I rang yesterday", it sees the caller's earlier calls, live chats and unified-inbox threads (matched on their number, and on the email of any order verified that call), plus any return or damage request still open.
- **Reads the shop's own pages, articles and reviews.** Policy questions are answered from the published pages (returns, delivery, terms), buying questions from Gazette articles, and "is it comfy?" from published reviews. Read live, cached for five minutes.
- **Answers "can you get it to ... by Friday?"** from the checkout's own delivery zones and carve-outs, then the product's delivery forecast.
- **Lists what it could not answer.** Every question it had no answer for lands on the Unanswered tab, noted by the assistant or spotted in the transcript afterwards, with a notification each Monday.
- **Takes a message for anything it cannot handle**: the caller's name and email (read back to them to be sure), and what it is about. You are notified, and it stays flagged until you mark it done.
- **Writes up every call** in the unified inbox with a summary, who called, which orders were checked, any callback details, and the full transcript, with each lookup the assistant made shown where it happened (order lookups are reduced to whether they matched).
- **Never passes itself off as a person.** Asked, it says plainly it is the shop's automated assistant.
- **Keeps itself up to date.** After a module update an hourly job pushes the new wording and tools to ElevenLabs, provided no setting has changed since the assistant was last set up (a changed setting still waits for you to press the button) and no call is in progress.
- **Warns about clashing instructions.** The Extra instructions box flags lines that fight the built-in rules: payment or invoice facts the tools read live, web addresses, fixed delivery times, prices, or telling it to pass as a person.

If the assistant is off, not set up, or ElevenLabs is slow or down, the call carries on to your normal forwarding and voicemail. Callers are never worse off for it being installed.

## Requirements

- The **Twilio**, **Shop** and **Unified Inbox** modules.
- For ElevenLabs: an ElevenLabs account with an API key that can use Agents, Voices and Workspace webhooks.
- For GPT-Live: an OpenAI project with GPT-Live access, a project API key, and a webhook on that project. The site must run as a long-lived server (how Cactus sites are hosted): it keeps a connection to OpenAI open for the length of each call.
- `ENCRYPTION_KEY` set on the site (keys are stored encrypted). Optionally `ELEVENLABS_API_KEY` / `OPENAI_API_KEY` instead of pasting the keys in.

## Setting it up

1. In **Settings > AI Call Answering > Assistant**, paste the ElevenLabs key, pick a voice, set your business name, and press **Set up the assistant**. That creates the agent, its tools and the post-call webhook at ElevenLabs. Press it again whenever you change the voice or wording.
2. In the **Twilio** tab, make sure the number has call handling on (forwarding or voicemail). That is what points the number at your site.
3. In **Phone numbers**, tick the numbers the assistant should answer, and choose whether it answers every call or only when the number is shut or nothing would ring.
4. Switch the assistant **on**.

### Using GPT-Live instead

1. In **Assistant**, set **Voice engine** to OpenAI GPT-Live 1.
2. Paste the OpenAI project key and the project ID (`proj_...`, under Settings > Project > General).
3. In that OpenAI project, under Settings > Webhooks, add an endpoint at the address the tab shows (`/api/m/ai-call-answering/webhooks/openai-live`) for the `live.transport.incoming` event, and paste its signing secret (`whsec_...`) into the tab.
4. Pick a voice and a thinking model, **Save changes**, and switch the assistant on. There is nothing to press at OpenAI: every call is given the current wording as it arrives.

The voice list has all 38 built-in GPT-Live voices, grouped with the British and Irish ones first, each with a **Play** button, plus a box for a custom voice id. OpenAI publishes no sample clips, so Play has GPT-Live itself say a line in that voice, with your business name (a few seconds of a billed session the first time; then kept in the site's memory). Play works once an OpenAI key is saved.

The voice model (`gpt-live-1`) holds the conversation and hands each question to the thinking model (GPT-6 Luna by default), which follows the same rules and uses the same tools as the ElevenLabs assistant. Twilio puts the call through to the project's SIP address (`;transport=tls;secure=true`: GPT-Live refuses a call whose audio is not encrypted with SRTP, and `transport=tls` alone only encrypts the signalling) with a signed reference to the call; the site checks the reference before accepting, so somebody who learns the address cannot borrow another caller's session. The site then keeps a "sideband" connection to the call, runs the tools over it, and files the transcript, an overview written by the thinking model, and what the call used.

**Prompt caching.** GPT-Live offers no cache setting of its own, so the module makes the cache work for it: the thinking model's instructions and tool list are built only from the site's settings, never the caller or the time, and in a fixed order, so every lookup of every call starts with the same several thousand tokens. OpenAI then serves them from its cache at a fraction of the price. Each call records how much of its input came from the cache (`acall_calls.usage`), and the server log prints the share when the call is filed.

If OpenAI cannot take the call, or the site cannot attach to it, the call drops within seconds and goes to the number's voicemail, as with ElevenLabs.

## How it fits together

| Piece | What it is |
| --- | --- |
| `twilio.inbound-call-handler` | The hook the Twilio module offers every call to. The assistant takes the call by asking ElevenLabs to register it and returning the connection instructions. |
| `core.conversation-provider` | Publishes each call to the unified inbox as a phone conversation. |
| `tools/<name>` | The tools the assistant calls mid-call: `search_products`, `find_by_sku`, `get_product`, `list_categories`, `get_faqs`, `get_payment_info`, `lookup_order`, `lookup_caller_orders`, `email_order_link`, `email_summary`, `save_callback`, `build_basket`, `send_text`, `get_caller_history`, `search_pages`, `check_delivery_postcode`, `get_reviews`, `search_guides`, `note_unanswered`. Authenticated with a random bearer token made at setup. |
| `public/basket?t=` | The link sent for a phone basket: copies its lines into the browser's basket and redirects to it. Works for 30 days. |
| `cron/unanswered` | Mondays: notification with the week's count of unanswered questions. |
| `cron/resync` | Hourly: pushes a module update to ElevenLabs when only the code changed. Needs `CRON_SECRET`. |
| `webhooks/post-call` | ElevenLabs delivers the transcript here after hang-up. Checked against its HMAC signature. |
| `webhooks/openai-live` | GPT-Live only: OpenAI announces an incoming call here (Standard Webhooks signature). The site accepts it with the instructions and tools, then runs the call's tools over a sideband connection until it ends. |

Calls from other agents in the same ElevenLabs workspace are ignored.

### Fallback keys

ElevenLabs credit runs out per account. Under **Settings > AI Call Answering > Assistant > Fallback ElevenLabs keys** you can add up to five keys from other ElevenLabs accounts. Press **Update the assistant** and each gets its own agent, tools and post-call webhook. A call goes to the main key first; if ElevenLabs refuses it (out of credit, over its limit, key rejected) or is too slow, the next key is tried, and a refused key is tried last for five minutes. If none connects, forwarding and voicemail take the call as before. Finished calls from any of the accounts are filed. The chosen voice must exist on every account.

## Costs

ElevenLabs charges by the minute for conversations and Twilio charges for the call. GPT-Live is charged by OpenAI per second of call, plus the thinking model's tokens (most of them cached). The longest-call setting stops a runaway conversation.
