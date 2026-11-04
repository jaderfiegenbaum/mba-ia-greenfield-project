import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { StorageInvalidPartsError } from './storage.errors';
import type {
  CompletedPart,
  PresignGetOptions,
  UploadedPart,
} from './storage.types';

const INVALID_PARTS_ERROR_NAMES = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'NoSuchUpload',
  'EntityTooSmall',
]);

/**
 * Single entry point to the S3-compatible object storage.
 *
 * Two clients (phase-03-videos/TD-09):
 * - `internalClient` talks to the storage through the Compose network
 *   (service name) for every server-side operation;
 * - `publicClient` is only used to sign URLs handed to clients, so the
 *   signed Host is reachable from outside Docker.
 */
@Injectable()
export class StorageService {
  private readonly internalClient: S3Client;
  private readonly publicClient: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    this.internalClient = StorageService.createClient(config, config.endpoint);
    this.publicClient = StorageService.createClient(
      config,
      config.publicEndpoint,
    );
  }

  private static createClient(
    config: ConfigType<typeof storageConfig>,
    endpoint: string,
  ): S3Client {
    return new S3Client({
      endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      // Presigned URLs must not embed SDK checksum parameters that the
      // uploading client cannot reproduce (library-refs.md → client-s3).
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error(`Storage returned no UploadId for ${key}`);
    }
    return result.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    try {
      do {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber ?? 0,
            etag: part.ETag ?? '',
            size: part.Size ?? 0,
          });
        }
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
      } while (marker);
    } catch (error) {
      throw StorageService.translate(error);
    }
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: ordered.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (error) {
      throw StorageService.translate(error);
    }
  }

  async headObjectSize(key: string): Promise<number> {
    const result = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return result.ContentLength ?? 0;
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async presignGet(key: string, options: PresignGetOptions): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.downloadFileName !== undefined && {
          ResponseContentDisposition: StorageService.attachment(
            options.downloadFileName,
          ),
        }),
      }),
      { expiresIn: options.expiresIn },
    );
  }

  // Signed against the internal endpoint: for server-side consumers inside
  // the Compose network (e.g. ffprobe/ffmpeg in the video worker).
  async presignInternalGet(key: string, expiresIn: number): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn },
    );
  }

  private static attachment(fileName: string): string {
    const safe = fileName.replace(/["\\\r\n]/g, '_');
    return `attachment; filename="${safe}"`;
  }

  private static translate(error: unknown): unknown {
    if (
      error instanceof S3ServiceException &&
      INVALID_PARTS_ERROR_NAMES.has(error.name)
    ) {
      return new StorageInvalidPartsError(error.message);
    }
    return error;
  }
}
