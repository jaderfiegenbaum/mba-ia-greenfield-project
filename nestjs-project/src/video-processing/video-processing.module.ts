import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), StorageModule, QueueModule],
  providers: [
    MediaProbeService,
    VideoProcessingService,
    VideoProcessingProcessor,
  ],
})
export class VideoProcessingModule {}
