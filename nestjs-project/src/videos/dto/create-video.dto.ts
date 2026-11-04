import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const TEN_GIB = 10 * 1024 * 1024 * 1024;

export class CreateVideoDto {
  /** Video title shown on the platform. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  /** Original file name, used as the download file name. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string;

  /** File size in bytes — at most 10 GiB (10737418240). */
  @IsInt()
  @Min(1)
  @Max(TEN_GIB)
  fileSize: number;

  /** MIME type of the file; only `video/*` is accepted. */
  @IsString()
  @Matches(/^video\/[\w.+-]+$/)
  contentType: string;
}
