import { registerAs } from '@nestjs/config';

// Redis connection used by BullMQ (phase-03-videos/TD-01).
export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST as string,
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
}));
