import { DomainException } from '../../common/exceptions/domain.exception';

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'The authenticated user has no channel');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotDraftException extends DomainException {
  constructor() {
    super('VIDEO_NOT_DRAFT', 409, 'The video upload was already completed');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'The video is not ready for playback');
  }
}

export class UploadIncompleteException extends DomainException {
  constructor() {
    super(
      'UPLOAD_INCOMPLETE',
      422,
      'The storage rejected the uploaded parts; upload every part and retry',
    );
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SIZE_MISMATCH',
      422,
      'The uploaded file size differs from the declared file size',
    );
  }
}
