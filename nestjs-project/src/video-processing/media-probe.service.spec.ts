import { MediaProbeService } from './media-probe.service';

describe('MediaProbeService', () => {
  describe('thumbnailTimestamp', () => {
    it('should pick 10% of the duration for regular videos', () => {
      expect(MediaProbeService.thumbnailTimestamp(600)).toBe(60);
    });

    it('should cap to the last second for very short clips', () => {
      expect(MediaProbeService.thumbnailTimestamp(1.05)).toBeCloseTo(0.05);
      expect(MediaProbeService.thumbnailTimestamp(0.5)).toBe(0);
    });
  });
});
