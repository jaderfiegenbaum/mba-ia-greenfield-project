import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const TEN_GIB = 10 * 1024 * 1024 * 1024;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let counter = 0;

  beforeAll(async () => {
    // Schema comes from the migrations (no synchronize).
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      { synchronize: false },
    );
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    counter += 1;
    const user = await dataSource.getRepository(User).save({
      email: `video_owner_${counter}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: `owner${counter}`,
      nickname: `owner${counter}`,
      user_id: user.id,
    });
  });

  function buildVideo(overrides: Partial<Video> = {}): Partial<Video> {
    const id = randomUUID();
    return {
      id,
      channel_id: channel.id,
      public_id: randomUUID().replace(/-/g, '').slice(0, 11),
      title: 'My video',
      original_file_name: 'clip.mp4',
      content_type: 'video/mp4',
      file_size: 1024,
      storage_key: `videos/${id}/original`,
      ...overrides,
    };
  }

  it('should default status to draft', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.upload_id).toBeNull();
    expect(found.metadata).toBeNull();
  });

  it('should reject a duplicated public_id', async () => {
    await videoRepository.save(buildVideo({ public_id: 'AAAAAAAAAAA' }));

    await expect(
      videoRepository.save(buildVideo({ public_id: 'AAAAAAAAAAA' })),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should reject an invalid status value', async () => {
    const video = buildVideo();

    await expect(
      dataSource.query(
        `INSERT INTO videos (id, channel_id, public_id, title, original_file_name, content_type, file_size, storage_key, status)
         VALUES ($1, $2, $3, 't', 'f', 'video/mp4', 1, 'k', 'archived')`,
        [video.id, channel.id, video.public_id],
      ),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should delete videos when their channel is deleted (cascade)', async () => {
    const saved = await videoRepository.save(buildVideo());

    await dataSource.query('DELETE FROM channels WHERE id = $1', [channel.id]);

    expect(await videoRepository.findOneBy({ id: saved.id })).toBeNull();
  });

  it('should persist a 10 GiB file_size and read it back as a number', async () => {
    const saved = await videoRepository.save(
      buildVideo({ file_size: TEN_GIB }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.file_size).toBe(TEN_GIB);
  });

  it('should persist processing results as typed columns', async () => {
    const saved = await videoRepository.save(
      buildVideo({
        status: VideoStatus.READY,
        duration_seconds: 4.04,
        metadata: {
          formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
          bitRate: 120000,
          width: 640,
          height: 360,
          videoCodec: 'h264',
          audioCodec: null,
          frameRate: 25,
        },
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.duration_seconds).toBeCloseTo(4.04);
    expect(found.metadata?.width).toBe(640);
  });
});
