export const VIDEO_UPLOAD = {
  // Fixed multipart part size (phase-03-videos/TD-02): 10 GiB → ~103 parts.
  PART_SIZE_BYTES: 100 * 1024 * 1024,
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024 * 1024,
  MAX_PARTS: 10000,
  URL_EXPIRES_IN_SECONDS: 3600,
  PUBLIC_ID_MAX_ATTEMPTS: 5,
} as const;

// Presigned GET TTL for stream, download and thumbnail URLs
// (phase-03-videos/TD-06).
export const VIDEO_PLAYBACK_URL_EXPIRES_IN_SECONDS = 3600;

export const videoStorageKeys = {
  original: (videoId: string): string => `videos/${videoId}/original`,
  thumbnail: (videoId: string): string => `videos/${videoId}/thumbnail.jpg`,
};
