import { Test } from '@nestjs/testing';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { storageTestConfig } from './storage-test-config';

// Builds a StorageService through the Nest DI container with an explicit
// storage config (defaults to the in-network test config).
export async function createStorageService(
  config: ConfigType<typeof storageConfig> = storageTestConfig(),
): Promise<StorageService> {
  const module = await Test.createTestingModule({
    providers: [
      StorageService,
      { provide: storageConfig.KEY, useValue: config },
    ],
  }).compile();
  return module.get(StorageService);
}
