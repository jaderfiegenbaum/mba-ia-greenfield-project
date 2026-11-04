import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class PartUploadUrlDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({
    description: 'Presigned UploadPart URL — PUT the part bytes here',
  })
  url: string;
}

export class UploadPlanDto {
  @ApiProperty({ example: 104857600 })
  partSize: number;

  @ApiProperty({ example: 3 })
  partCount: number;

  @ApiProperty({ example: 3600, description: 'Seconds the URLs stay valid' })
  expiresIn: number;

  @ApiProperty({ type: [PartUploadUrlDto] })
  parts: PartUploadUrlDto[];
}

export class VideoUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  publicId: string;

  @ApiProperty({ example: 'My video' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ type: UploadPlanDto })
  upload: UploadPlanDto;
}
