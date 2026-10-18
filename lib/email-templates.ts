import type { EmailTemplateDef } from '@/lib/email/registry'

// The emails the phone assistant can send, declared for core's single email
// editor (Settings > Emails). Core owns the wording, the wrapper design and the
// sending; this file is only the defaults and what may be merged in.
//
// It is sent when a caller who has proved who they are asks for their order
// link by email - typically because they need the order page (to upload photos
// of damaged goods, say) and the confirmation email is not to hand. It only
// ever goes to the address on the order, never to one spoken on the call.
//
// Transactional: the customer asked for it, on the phone, a moment ago.
//
// The call-summary email is the other: when a caller asks for a note of what was
// discussed (product advice, mostly), it goes to the address they gave or the
// one on their order. {{summaryHtml}}, {{productsHtml}} and {{signatureHtml}}
// are built in code from escaped text and the shop's own product rows. The
// signature is the one set on the assistant's settings, not a site-wide one.
//
// {{reportIssueUrl}} is the order link with the issue form already open. It is
// empty on a shop that has issue reports switched off, which takes its whole
// {{#if hasReportIssueUrl}} line with it.

export const aiCallAnsweringEmailTemplates: EmailTemplateDef[] = [
  {
    key: 'ai-call-answering.order-link',
    label: 'Order link, asked for on the phone',
    subject: 'Your order link for {{orderNumber}}',
    bodyHtml:
      '<p>Hi {{customerName}},</p><p>Thanks for ringing. As promised, here is the link to your order <strong>{{orderNumber}}</strong>:</p><p><a href="{{orderUrl}}">{{orderUrl}}</a></p>{{#if hasReportIssueUrl}}<p>If something arrived damaged, <a href="{{reportIssueUrl}}">use this link to tell us about it</a> and add photos there, so we can pass them on to the supplier.</p>{{/if}}<p>If anything is unclear, just reply to this email.</p>',
    mergeTags: ['customerName', 'orderNumber', 'orderUrl', 'reportIssueUrl', 'hasReportIssueUrl', 'siteName'],
    requiredTags: ['orderUrl'],
    transactional: true,
  },
  {
    key: 'ai-call-answering.call-summary',
    label: 'Note of what was discussed on the phone',
    subject: '{{subject}}',
    bodyHtml:
      '<p>Hi {{customerName}},</p><p>Thanks for ringing. As promised, here is a note of what we talked about:</p>{{summaryHtml}}{{#if hasProducts}}<p><strong>The products we mentioned</strong></p>{{productsHtml}}{{/if}}<p>If anything is unclear, just reply to this email.</p>{{signatureHtml}}',
    mergeTags: ['customerName', 'subject', 'summaryHtml', 'productsHtml', 'hasProducts', 'signatureHtml', 'siteName'],
    requiredTags: ['summaryHtml'],
    rawTags: ['summaryHtml', 'productsHtml', 'signatureHtml'],
    transactional: true,
  },
]
