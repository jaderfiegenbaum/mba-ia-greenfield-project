import { generatePublicId, PUBLIC_ID_PATTERN } from './public-id.util';

describe('generatePublicId', () => {
  it('should produce 11 base64url characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePublicId()).toMatch(PUBLIC_ID_PATTERN);
    }
  });

  it('should produce different ids on consecutive calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generatePublicId()));
    expect(ids.size).toBe(1000);
  });
});
