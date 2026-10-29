import { describe, expect, it } from 'vitest'
import { findInstructionConflicts } from './instruction-conflicts'

describe('findInstructionConflicts', () => {
  it('flags payment facts the tools read live', () => {
    const found = findInstructionConflicts('- Customers pay when they order. No credit or invoicing.')
    expect(found).toHaveLength(1)
    expect(found[0]!.quote).toBe('No credit or invoicing.')
  })

  it('flags a web address with a path', () => {
    expect(findInstructionConflicts('Track orders at deskwell.co.uk/track-order.')).toHaveLength(1)
  })

  it('leaves a bare email address alone', () => {
    expect(findInstructionConflicts('Email hi@deskwell.co.uk for anything else.')).toHaveLength(0)
  })

  it('flags a delivery promise but not a ban on one', () => {
    expect(findInstructionConflicts('We deliver next day.')).toHaveLength(1)
    expect(findInstructionConflicts('Never quote your own figure or say next-day.')).toHaveLength(0)
  })

  it('flags pretending to be a person, not a persona or a denial', () => {
    expect(findInstructionConflicts('Say you are a real person if asked.')).toHaveLength(1)
    expect(findInstructionConflicts('You are Charlotte, phone assistant for Deskwell.')).toHaveLength(0)
    expect(findInstructionConflicts("If asked, say you're not a person but the automated assistant.")).toHaveLength(0)
  })

  it('leaves a returns window and a price-saying example alone', () => {
    expect(findInstructionConflicts('Returns within 14 days of dispatch.')).toHaveLength(0)
    expect(findInstructionConflicts('In emails always use figures ("£249.00 + VAT").')).toHaveLength(0)
    expect(findInstructionConflicts('Chairs are from £49 each.')).toHaveLength(1)
    expect(findInstructionConflicts('We deliver within 3 working days.')).toHaveLength(1)
  })

  it('warns once per kind', () => {
    expect(findInstructionConflicts('No invoicing. No bank transfer.')).toHaveLength(1)
  })
})
