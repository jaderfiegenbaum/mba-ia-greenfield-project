import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { ModuleMetadata } from '@nestjs/common';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { storageTestConfig } from './storage-test-config';

export const VIDEO_TEST_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
];

// Real DB (schema from migrations) + real MinIO, for integration tests of the
// videos / video-processing services.
export async function createVideosIntegrationModule(
  metadata: ModuleMetadata = {},
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'postgres',
        host: process.env.DB_HOST ?? 'db',
        port: Number(process.env.DB_PORT ?? 5432),
        username: process.env.DB_USERNAME ?? 'streamtube',
        password: process.env.DB_PASSWORD ?? 'streamtube',
        database: process.env.DB_NAME ?? 'streamtube',
        entities: VIDEO_TEST_ENTITIES,
        synchronize: false,
      }),
      TypeOrmModule.forFeature([Video]),
      ...(metadata.imports ?? []),
    ],
    providers: [
      ChannelsService,
      StorageService,
      { provide: storageConfig.KEY, useValue: storageTestConfig() },
      ...(metadata.providers ?? []),
    ],
  }).compile();
}
