import { describe, it, expect } from 'vitest';
import { RejectionBudget } from './rejection-budget.ts';
describe('repeated refusals across connections', () => {
  it('blocks only the faulty account after three refusals and expires after one minute', () => {
    let now = 0;
    const budget = new RejectionBudget(() => now);
    budget.reject('bad');
    now = 1000;
    budget.reject('bad');
    expect(budget.blocked('bad')).toBe(false);
    now = 2000;
    budget.reject('bad');
    expect(budget.blocked('bad')).toBe(true);
    expect(budget.blocked('healthy')).toBe(false);
    now = 61999;
    expect(budget.blocked('bad')).toBe(true);
    now = 62000;
    expect(budget.blocked('bad')).toBe(false);
    budget.reject('bad');
    expect(budget.blocked('bad')).toBe(false);
  });
  it('does not accumulate refusals outside the rolling observation window', () => {
    let now = 0;
    const budget = new RejectionBudget(() => now);
    budget.reject('u');
    budget.reject('u');
    now = 60001;
    budget.reject('u');
    expect(budget.blocked('u')).toBe(false);
  });
});
