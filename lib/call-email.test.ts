import { describe, expect, it } from 'vitest'
import { cleanSubject, pickRecipient, productsHtml, signatureHtml, textToHtml } from './call-email'
import type { CallRecord } from './calls'

const call = (over: Partial<CallRecord> = {}) =>
  ({ verifiedContact: { name: '', email: '', phone: '' }, callerEmail: '', ...over }) as CallRecord

describe('textToHtml', () => {
  it('escapes markup and keeps paragraphs and line breaks', () => {
    expect(textToHtml('One <b>line</b>\nnext\n\nSecond')).toBe('<p>One &lt;b&gt;line&lt;/b&gt;<br>next</p><p>Second</p>')
  })
})

describe('signatureHtml', () => {
  it('is empty for blank text and escapes otherwise', () => {
    expect(signatureHtml('  \n ')).toBe('')
    expect(signatureHtml('Alex\nDeskwell <x>')).toContain('Alex<br>Deskwell &lt;x&gt;')
  })
  it('keeps pasted HTML but strips anything live', () => {
    const out = signatureHtml('<table><tr><td style="color:#000">Hi <img src="https://x/y.png" onerror="alert(1)"></td></tr></table><script>x()</script>')
    expect(out).toContain('<table')
    expect(out).toContain('https://x/y.png')
    expect(out).not.toMatch(/onerror|<script/i)
  })
})

describe('cleanSubject', () => {
  it('flattens to one line and falls back', () => {
    expect(cleanSubject('Desks\nwe  discussed')).toBe('Desks we discussed')
    expect(cleanSubject('  ')).toBe('A note of what we talked about')
  })
})

describe('pickRecipient', () => {
  it('prefers the spoken address, then the order, then the callback', () => {
    const c = call({ verifiedContact: { name: 'Jo', email: 'Jo@Example.com', phone: '' }, callerEmail: 'cb@example.com' })
    expect(pickRecipient(c, 'Said@Example.com')).toEqual({ email: 'said@example.com', fromOrder: false })
    expect(pickRecipient(c, null)).toEqual({ email: 'jo@example.com', fromOrder: true })
    expect(pickRecipient(call({ callerEmail: 'cb@example.com' }), 'not an email')).toEqual({ email: 'cb@example.com', fromOrder: false })
    expect(pickRecipient(call(), null)).toBeNull()
  })
})

describe('productsHtml', () => {
  it('links each product with its price', () => {
    const html = productsHtml([{ name: 'Desk "A"', price: '£100', basis: 'excluding VAT', url: 'https://x.test/desk' }])
    expect(html).toContain('<a href="https://x.test/desk">Desk &quot;A&quot;</a> - £100 excluding VAT')
    expect(productsHtml([])).toBe('')
  })
})
