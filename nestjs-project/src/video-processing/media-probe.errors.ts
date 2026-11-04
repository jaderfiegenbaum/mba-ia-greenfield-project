export class MediaProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaProbeError';
  }
}
