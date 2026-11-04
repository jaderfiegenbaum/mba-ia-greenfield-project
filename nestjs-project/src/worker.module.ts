import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from './channels/entities/channel.entity';
import databaseConfig from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import { User } from './users/entities/user.entity';
import { VideoProcessingModule } from './video-processing/video-processing.module';
import { Video } from './videos/entities/video.entity';

// Root module of the video worker process: no HTTP layer, only the queue
// consumer and what it needs (phase-03-videos/TD-03).
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        // Video → Channel → User relation graph must be fully registered.
        entities: [Video, Channel, User],
        synchronize: false,
      }),
    }),
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
