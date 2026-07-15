import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/** A single uploaded multipart part, as reported by the client after each PUT. */
export class CompletedPartDto {
  /** 1-based index of the part, matching the presigned URL used to upload it. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  partNumber: number;

  /** ETag returned by the storage in the PUT response for this part. */
  @IsString()
  @IsNotEmpty()
  eTag: string;
}

/** Body for `POST /videos/:publicId/uploads/complete`. */
export class CompleteUploadDto {
  /** All parts uploaded for this multipart upload, in any order. */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
