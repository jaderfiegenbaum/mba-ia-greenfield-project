export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface PresignGetOptions {
  expiresIn: number;
  // When set, the URL forces a download with this file name
  // (Content-Disposition: attachment).
  downloadFileName?: string;
}
