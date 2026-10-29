import { describe, it, expect } from 'vitest';
import { pickSessionPrice } from './quotes';

const at = (iso: string) => new Date(iso);

describe('pickSessionPrice', () => {
  // Yesterday's close + post-market, plus this morning's pre-market
  const PRE = { preMarketPrice: 101, preMarketTime: at('2026-10-29T13:20:00Z') };        // 09:20 ET
  const REGULAR = { regularMarketPrice: 100, regularMarketTime: at('2026-10-28T20:00:00Z') }; // 16:00 ET yesterday
  const POST = { postMarketPrice: 99, postMarketTime: at('2026-10-28T23:59:00Z') };       // 19:59 ET yesterday

  it('uses the pre-market price before the open', () => {
    expect(pickSessionPrice({ ...PRE, ...REGULAR, ...POST })).toEqual({ price: 101, session: 'pre', time: PRE.preMarketTime });
  });

  it('uses the regular price during the session', () => {
    const live = { regularMarketPrice: 102, regularMarketTime: at('2026-10-29T15:30:00Z') };
    expect(pickSessionPrice({ ...PRE, ...live, ...POST })).toEqual({ price: 102, session: 'regular', time: live.regularMarketTime });
  });

  it('uses the post-market price after the close and overnight', () => {
    expect(pickSessionPrice({ ...REGULAR, ...POST })).toEqual({ price: 99, session: 'post', time: POST.postMarketTime });
  });

  it('falls back to an untimed price only when nothing else is usable', () => {
    expect(pickSessionPrice({ regularMarketPrice: 100 })).toEqual({ price: 100, session: 'regular', time: new Date(0) });
    expect(pickSessionPrice({ regularMarketPrice: 100, ...PRE })?.session).toBe('pre');
  });

  it('ignores missing and non-positive prices', () => {
    expect(pickSessionPrice({ preMarketPrice: 0, preMarketTime: PRE.preMarketTime, ...REGULAR })?.session).toBe('regular');
    expect(pickSessionPrice({})).toBeNull();
  });
});
