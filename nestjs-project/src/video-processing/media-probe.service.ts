import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import type { VideoMetadata } from '../videos/entities/video.entity';
import { MediaProbeError } from './media-probe.errors';

export interface ProbeResult {
  durationSeconds: number;
  metadata: VideoMetadata;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string; bit_rate?: string };
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const THUMBNAIL_WIDTH = 1280;
const STDERR_LIMIT = 2000;

/**
 * Adapter over the system ffprobe/ffmpeg binaries (phase-03-videos/TD-04).
 * Inputs are HTTP(S) URLs: ffmpeg reads only the byte ranges it needs, so a
 * 10 GB source is never copied to the worker's disk.
 */
@Injectable()
export class MediaProbeService {
  async probe(url: string): Promise<ProbeResult> {
    const stdout = await this.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ]);

    let output: FfprobeOutput;
    try {
      output = JSON.parse(stdout.toString('utf8')) as FfprobeOutput;
    } catch {
      throw new MediaProbeError('ffprobe returned invalid JSON');
    }

    const videoStream = output.streams?.find(
      (stream) => stream.codec_type === 'video',
    );
    const audioStream = output.streams?.find(
      (stream) => stream.codec_type === 'audio',
    );
    const durationSeconds = Number(output.format?.duration);
    if (!videoStream || !Number.isFinite(durationSeconds)) {
      throw new MediaProbeError('The file has no video stream or duration');
    }

    return {
      durationSeconds,
      metadata: {
        formatName: output.format?.format_name ?? null,
        bitRate: MediaProbeService.toNumber(output.format?.bit_rate),
        width: videoStream.width ?? null,
        height: videoStream.height ?? null,
        videoCodec: videoStream.codec_name ?? null,
        audioCodec: audioStream?.codec_name ?? null,
        frameRate: MediaProbeService.parseFrameRate(videoStream.avg_frame_rate),
      },
    };
  }

  async captureThumbnail(
    url: string,
    durationSeconds: number,
  ): Promise<Buffer> {
    const at = MediaProbeService.thumbnailTimestamp(durationSeconds);
    const jpeg = await this.run('ffmpeg', [
      '-v',
      'error',
      '-ss',
      at.toFixed(3),
      '-i',
      url,
      '-frames:v',
      '1',
      '-vf',
      `scale=${THUMBNAIL_WIDTH}:-2`,
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1',
    ]);
    if (jpeg.length === 0) {
      throw new MediaProbeError('ffmpeg produced no thumbnail frame');
    }
    return jpeg;
  }

  // Frame at 10% of the duration, capped to the last second for short clips.
  static thumbnailTimestamp(durationSeconds: number): number {
    return Math.min(durationSeconds * 0.1, Math.max(durationSeconds - 1, 0));
  }

  private run(
    command: string,
    args: string[],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new MediaProbeError(`${command} timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new MediaProbeError(`${command} failed to start: ${error.message}`),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(Buffer.concat(stdout));
        } else {
          reject(
            new MediaProbeError(
              `${command} exited with code ${code}: ${stderr.trim().slice(0, 300)}`,
            ),
          );
        }
      });
    });
  }

  private static toNumber(value: string | undefined): number | null {
    const parsed = Number(value);
    return value !== undefined && Number.isFinite(parsed) ? parsed : null;
  }

  private static parseFrameRate(value: string | undefined): number | null {
    if (!value) return null;
    const [numerator, denominator] = value.split('/').map(Number);
    if (!denominator || !Number.isFinite(numerator)) return null;
    return Math.round((numerator / denominator) * 1000) / 1000;
  }
}
