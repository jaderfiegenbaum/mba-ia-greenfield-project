import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { User } from '../src/users/entities/user.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/video-processing/video-processing.constants';

export interface VideosE2eContext {
  app: INestApplication<App>;
  dataSource: DataSource;
  queue: Queue;
  throttlerStorage: ThrottlerStorageService;
}

// The e2e process runs inside the Compose network, where the host-facing
// public endpoint (localhost:9000) is unreachable: sign client URLs with the
// in-network endpoint instead.
export async function bootstrapVideosApp(): Promise<VideosE2eContext> {
  process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  return {
    app,
    dataSource: moduleFixture.get(DataSource),
    queue: moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE)),
    throttlerStorage:
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage),
  };
}

let userCounter = 0;

// Confirmed user + channel + a real access token signed by the app's
// JwtService (same secret/expiry the global guard verifies).
export async function createUserWithToken(
  context: VideosE2eContext,
): Promise<{ userId: string; token: string }> {
  userCounter += 1;
  const email = `video_e2e_${Date.now()}_${userCounter}@example.com`;
  const user = await context.dataSource.getRepository(User).save({
    email,
    password: 'not-used',
    is_confirmed: true,
  });
  const nickname = `ve2e${Date.now() % 100000}${userCounter}`;
  await context.dataSource.getRepository(Channel).save({
    name: nickname,
    nickname,
    user_id: user.id,
  });
  const token = await context.app
    .get(JwtService, { strict: false })
    .signAsync({ sub: user.id, email, jti: randomUUID() });
  return { userId: user.id, token };
}
