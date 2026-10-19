<p align="center">
  <img src="module-art.webp" alt="AI Call Answering module" width="640" />
</p>

# AI Call Answering module

A voice assistant that answers your phone. Built on the [Twilio module](https://github.com/cactus-foundation-modules/twilio) for the phone line and [ElevenLabs](https://elevenlabs.io) for the voice and the conversation.

## What it does

- **Answers calls** on the numbers you choose, in a natural ElevenLabs voice (Eleven v4 by default).
- **Answers questions about any product** in your shop: sizes, options, price, stock, specifications and your FAQs (product, category, collection and shop-wide).
- **Suggests products** from the shop based on what the caller needs and what they want to spend.
- **Handles order enquiries**, but only after checking who is calling. It needs the delivery postcode plus one of the order number, the email address or the company name. Wrong answers are limited per call and per number, and nothing like an email, phone number or street address is ever read out.
- **Emails the order link** to the address on the order, when a verified caller cannot find it in their confirmation email. The wording is editable under Settings > Emails, and the address it leaves from is chosen on the Assistant tab (needs the Unified Inbox module).
- **Takes a message for anything it cannot handle**: the caller's name and email (read back to them to be sure), and what it is about. You are notified, and it stays flagged until you mark it done.
- **Writes up every call** in the unified inbox with a summary, who called, which orders were checked, any callback details, and the full transcript.

If the assistant is off, not set up, or ElevenLabs is slow or down, the call carries on to your normal forwarding and voicemail. Callers are never worse off for it being installed.

## Requirements

- The **Twilio**, **Shop** and **Unified Inbox** modules.
- An ElevenLabs account with an API key that can use Agents, Voices and Workspace webhooks.
- `ENCRYPTION_KEY` set on the site (the key is stored encrypted). Optionally `ELEVENLABS_API_KEY` instead of pasting the key in.

## Setting it up

1. In **Settings > AI Call Answering > Assistant**, paste the ElevenLabs key, pick a voice, set your business name, and press **Set up the assistant**. That creates the agent, its nine tools and the post-call webhook at ElevenLabs. Press it again whenever you change the voice or wording.
2. In the **Twilio** tab, make sure the number has call handling on (forwarding or voicemail). That is what points the number at your site.
3. In **Phone numbers**, tick the numbers the assistant should answer, and choose whether it answers every call or only when the number is shut or nothing would ring.
4. Switch the assistant **on**.

## How it fits together

| Piece | What it is |
| --- | --- |
| `twilio.inbound-call-handler` | The hook the Twilio module offers every call to. The assistant takes the call by asking ElevenLabs to register it and returning the connection instructions. |
| `core.conversation-provider` | Publishes each call to the unified inbox as a phone conversation. |
| `tools/<name>` | The nine tools the assistant calls mid-call: `search_products`, `get_product`, `list_categories`, `get_faqs`, `lookup_order`, `lookup_caller_orders`, `email_order_link`, `email_summary`, `save_callback`. Authenticated with a random bearer token made at setup. |
| `webhooks/post-call` | ElevenLabs delivers the transcript here after hang-up. Checked against its HMAC signature. |

Calls from other agents in the same ElevenLabs workspace are ignored.

### Fallback keys

ElevenLabs credit runs out per account. Under **Settings > AI Call Answering > Assistant > Fallback ElevenLabs keys** you can add up to five keys from other ElevenLabs accounts. Press **Update the assistant** and each gets its own agent, tools and post-call webhook. A call goes to the main key first; if ElevenLabs refuses it (out of credit, over its limit, key rejected) or is too slow, the next key is tried, and a refused key is tried last for five minutes. If none connects, forwarding and voicemail take the call as before. Finished calls from any of the accounts are filed. The chosen voice must exist on every account.

## Costs

ElevenLabs charges by the minute for conversations and Twilio charges for the call. The longest-call setting stops a runaway conversation.
