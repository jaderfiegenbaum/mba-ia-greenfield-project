import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';
import { PartUploadUrlDto } from './video-upload-response.dto';

export class StoredPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  etag: string;

  @ApiProperty({ example: 104857600 })
  size: number;
}

export class UploadStateResponseDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  publicId: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ example: 104857600 })
  partSize: number;

  @ApiProperty({ example: 3 })
  partCount: number;

  @ApiProperty({ example: 3600 })
  expiresIn: number;

  @ApiProperty({ type: [StoredPartDto] })
  uploadedParts: StoredPartDto[];

  @ApiProperty({
    type: [PartUploadUrlDto],
    description: 'Fresh URLs for the parts not uploaded yet',
  })
  parts: PartUploadUrlDto[];
}
