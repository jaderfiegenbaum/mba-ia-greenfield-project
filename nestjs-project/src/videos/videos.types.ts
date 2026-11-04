import type { VideoMetadata, VideoStatus } from './entities/video.entity';

export interface CreateVideoInput {
  title: string;
  fileName: string;
  fileSize: number;
  contentType: string;
}

export interface PartUploadUrl {
  partNumber: number;
  url: string;
}

export interface VideoUploadSession {
  id: string;
  publicId: string;
  title: string;
  status: VideoStatus;
  upload: {
    partSize: number;
    partCount: number;
    expiresIn: number;
    parts: PartUploadUrl[];
  };
}

export interface VideoUploadState {
  publicId: string;
  status: VideoStatus;
  partSize: number;
  partCount: number;
  expiresIn: number;
  uploadedParts: { partNumber: number; etag: string; size: number }[];
  parts: PartUploadUrl[];
}

export interface VideoSummary {
  id: string;
  publicId: string;
  title: string;
  status: VideoStatus;
}

export interface VideoDetails {
  publicId: string;
  title: string;
  status: VideoStatus;
  durationSeconds: number | null;
  metadata: VideoMetadata | null;
  thumbnailUrl: string | null;
  createdAt: Date;
}
