import { describe, it, expect } from 'vitest';
import {
  durationFromHours,
  variantInput,
} from '../src/services/managementValidation.js';

describe('owner duration entry in hours', () => {
  it('converts hours into the minute values used by pricing and availability', () => {
    expect(durationFromHours({ durationHours: '4' }).durationMin).toBe(240);
    expect(durationFromHours({ durationHours: '4.5' }).durationMin).toBe(270);
    expect(durationFromHours({ durationHours: '0.5' }).durationMin).toBe(30);
    expect(durationFromHours({ durationMin: 240 }).durationMin).toBe(240);
  });
  it('preserves a blank optional override and rejects invalid durations', () => {
    const input = durationFromHours({
      durationHours: '',
      size: '',
      length: '',
      price: '160',
    });
    expect(variantInput.parse(input).durationMin).toBeNull();
    for (const durationHours of ['abc', '0', '-1', '16', '4.001']) {
      expect(() => durationFromHours({ durationHours })).toThrow();
    }
  });
});
