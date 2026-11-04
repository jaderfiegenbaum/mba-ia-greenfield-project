import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadedPartDto {
  /** Part number (1-based). */
  @IsInt()
  @Min(1)
  @Max(10000)
  partNumber: number;

  /** ETag returned by the storage for this part. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Every uploaded part with the ETag returned by the storage. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  parts: UploadedPartDto[];
}
