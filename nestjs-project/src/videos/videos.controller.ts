import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { UploadStateResponseDto } from './dto/upload-state-response.dto';
import { VideoDetailsResponseDto } from './dto/video-details-response.dto';
import { VideoSummaryResponseDto } from './dto/video-summary-response.dto';
import { VideoUploadResponseDto } from './dto/video-upload-response.dto';
import { VideosService } from './videos.service';

const ERROR_SCHEMA = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft and starts a multipart upload. ' +
      'The client PUTs each part directly to the object storage using the ' +
      'returned presigned URLs — the file never passes through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created',
    type: VideoUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'The authenticated user has no channel',
    schema: ERROR_SCHEMA,
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<VideoUploadResponseDto> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Get(':publicId/upload')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the upload state (resume)',
    description:
      'Lists the parts already uploaded and returns fresh presigned URLs ' +
      'for the missing parts. Owner only, while the video is a draft.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload state',
    type: UploadStateResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'Video not found (or not owned by the caller)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'The upload was already completed',
    schema: ERROR_SCHEMA,
  })
  async getUploadState(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<UploadStateResponseDto> {
    return this.videosService.getUploadState(user.sub, publicId);
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the upload',
    description:
      'Assembles the uploaded parts, checks the final size, moves the video ' +
      'to processing and enqueues the processing job.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; processing started',
    type: VideoSummaryResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'Video not found (or not owned by the caller)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'The upload was already completed',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 422,
    description: 'Parts rejected by the storage or size mismatch',
    schema: ERROR_SCHEMA,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoSummaryResponseDto> {
    return this.videosService.completeUpload(user.sub, publicId, dto.parts);
  }

  @Public()
  @Get(':publicId')
  @ApiOperation({
    summary: 'Get a video by its unique public id',
    description:
      'Public details of a video, including duration, metadata and a ' +
      'presigned thumbnail URL once processing is done.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video details',
    type: VideoDetailsResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: ERROR_SCHEMA,
  })
  async getDetails(
    @Param('publicId') publicId: string,
  ): Promise<VideoDetailsResponseDto> {
    return this.videosService.getPublicDetails(publicId);
  }

  @Public()
  @Get(':publicId/stream')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects (302) to a short-lived presigned URL; the object storage ' +
      'answers Range requests with 206 Partial Content, so playback starts ' +
      'without downloading the whole file.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the stream URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: ERROR_SCHEMA,
  })
  async stream(
    @Param('publicId') publicId: string,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.videosService.getStreamUrl(publicId));
  }

  @Public()
  @Get(':publicId/download')
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects (302) to a short-lived presigned URL that serves the ' +
      'original file as an attachment.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the download URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: ERROR_SCHEMA,
  })
  async download(
    @Param('publicId') publicId: string,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.videosService.getDownloadUrl(publicId));
  }
}
