import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
  S3_BUCKET: 'bucket',
  REDIS_HOST: 'redis',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    expect((result.value as { SWAGGER_ENABLED: string }).SWAGGER_ENABLED).toBe(
      'false',
    );
  });
});

describe('envValidationSchema — storage and queue (phase 03)', () => {
  const validateRaw = (env: Record<string, string>) =>
    envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });

  it('should reject a config missing S3_* and REDIS_HOST, listing every missing key', () => {
    const storageAndQueueKeys = [
      'S3_ENDPOINT',
      'S3_PUBLIC_ENDPOINT',
      'S3_REGION',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'S3_BUCKET',
      'REDIS_HOST',
    ];
    const withoutStorageAndQueue = Object.fromEntries(
      Object.entries(requiredEnv).filter(
        ([key]) => !storageAndQueueKeys.includes(key),
      ),
    );

    const { error } = validateRaw(withoutStorageAndQueue);

    expect(error).toBeDefined();
    for (const key of storageAndQueueKeys) {
      expect(error!.message).toContain(key);
    }
  });

  it('should reject a non-URI S3_ENDPOINT', () => {
    const { error } = validate({ S3_ENDPOINT: 'not a uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });

  it('should accept a complete storage and queue config', () => {
    const { error } = validate({});
    expect(error).toBeUndefined();
  });

  it('should default REDIS_PORT to 6379', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    expect((result.value as { REDIS_PORT: number }).REDIS_PORT).toBe(6379);
  });
});
