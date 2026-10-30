import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/members/session', () => ({ getMemberFromCookie: async () => null }))

const { GET } = await import('@/modules/ai-call-answering/app/api/public/basket/route')

let savedProvider: string | undefined
let savedSite: string | undefined
let savedVercel: string | undefined
beforeEach(() => {
  savedProvider = process.env.CACTUS_HOSTING_PROVIDER
  savedSite = process.env.SITE_URL
  savedVercel = process.env.VERCEL
  delete process.env.VERCEL
  process.env.CACTUS_HOSTING_PROVIDER = 'server'
  process.env.SITE_URL = 'https://shop.example'
})
afterEach(() => {
  for (const [k, v] of [['CACTUS_HOSTING_PROVIDER', savedProvider], ['SITE_URL', savedSite], ['VERCEL', savedVercel]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

it('redirects to the basket on the public address, not the bind address', async () => {
  const request = new NextRequest('https://localhost:3101/api/m/ai-call-answering/public/basket', {
    headers: { host: 'shop.example', 'x-forwarded-proto': 'https' },
  })
  const res = await GET(request)
  expect(res.status).toBe(303)
  expect(res.headers.get('location')).toMatch(/^https:\/\/shop\.example\//)
})
