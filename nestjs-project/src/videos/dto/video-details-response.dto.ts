import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoMetadataDto {
  @ApiProperty({ nullable: true, example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  formatName: string | null;

  @ApiProperty({ nullable: true, example: 1250000 })
  bitRate: number | null;

  @ApiProperty({ nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ nullable: true, example: 'h264' })
  videoCodec: string | null;

  @ApiProperty({ nullable: true, example: 'aac' })
  audioCodec: string | null;

  @ApiProperty({ nullable: true, example: 29.97 })
  frameRate: number | null;
}

export class VideoDetailsResponseDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  publicId: string;

  @ApiProperty({ example: 'My video' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ nullable: true, example: 212.5 })
  durationSeconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({
    nullable: true,
    description: 'Presigned thumbnail URL (only when the video is ready)',
  })
  thumbnailUrl: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}
