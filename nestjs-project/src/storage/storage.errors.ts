// Storage-layer errors. They are infrastructure errors (not DomainException):
// callers translate them into domain errors of their own module.
export class StorageInvalidPartsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageInvalidPartsError';
  }
}
