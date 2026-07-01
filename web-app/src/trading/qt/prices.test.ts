import { describe, it, expect } from 'vitest';
import { pickQuotePrice } from './prices';

describe('pickQuotePrice', () => {
  it('prefers the bid/ask mid when present', () => {
    expect(pickQuotePrice({ bid: 99, ask: 101, last: 123 })).toEqual({ price: 100, source: 'mid' });
  });

  it('uses the mid even when last is missing', () => {
    expect(pickQuotePrice({ bid: 99, ask: 101, last: 0 })).toEqual({ price: 100, source: 'mid' });
  });

  it('falls back to the last trade when bid/ask is incomplete', () => {
    expect(pickQuotePrice({ bid: 99, ask: 0, last: 100 })).toEqual({ price: 100, source: 'last' });
    expect(pickQuotePrice({ bid: 0, ask: 101, last: 100 })).toEqual({ price: 100, source: 'last' });
  });

  it('returns none when nothing usable', () => {
    expect(pickQuotePrice({ bid: 0, ask: 0, last: 0 })).toEqual({ price: null, source: 'none' });
    expect(pickQuotePrice(undefined)).toEqual({ price: null, source: 'none' });
  });
});
