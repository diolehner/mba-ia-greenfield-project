import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VIDEO_STATUS } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should persist a video linked to a channel', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        publicId: 'abc123def456',
        title: 'My first video',
        storageKey: `channels/${channel.id}/videos/x/source/x.mp4`,
      }),
    );

    expect(video.id).toBeDefined();
    expect(video.channelId).toBe(channel.id);
    expect(video.createdAt).toBeInstanceOf(Date);
  });

  it('should default status to draft', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        publicId: 'defaultstatus',
        title: 'Status default',
        storageKey: 'key/source.mp4',
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.status).toBe(VIDEO_STATUS.DRAFT);
  });

  it('should enforce unique publicId constraint', async () => {
    const channel = await createChannel();

    await videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        publicId: 'duplicateid1',
        title: 'First',
        storageKey: 'key/one.mp4',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          channelId: channel.id,
          publicId: 'duplicateid1',
          title: 'Second',
          storageKey: 'key/two.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject a video referencing a non-existent channel (FK)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channelId: '00000000-0000-0000-0000-000000000000',
          publicId: 'orphanvideo1',
          title: 'Orphan',
          storageKey: 'key/orphan.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should cascade-delete videos when the owning channel is removed', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        publicId: 'cascadevideo',
        title: 'Cascade',
        storageKey: 'key/cascade.mp4',
      }),
    );

    await channelRepository.delete({ id: channel.id });

    const remaining = await videoRepository.findOneBy({
      publicId: 'cascadevideo',
    });
    expect(remaining).toBeNull();
  });

  it('should expose a public serialization without internal keys', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        publicId: 'publicserial',
        title: 'Public',
        storageKey: 'key/private.mp4',
        uploadId: 'multipart-upload-id',
      }),
    );

    const publicView = video.toPublic();

    expect(publicView).toHaveProperty('publicId', 'publicserial');
    expect(publicView).not.toHaveProperty('storageKey');
    expect(publicView).not.toHaveProperty('uploadId');
    expect(publicView).not.toHaveProperty('id');
    expect(publicView).not.toHaveProperty('channelId');
  });
});
