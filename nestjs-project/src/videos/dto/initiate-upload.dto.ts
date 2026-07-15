import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  Validate,
  ValidatorConstraint,
} from 'class-validator';
import type {
  ValidationArguments,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'fileSizeOrPartsCount', async: false })
class FileSizeOrPartsCountConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as InitiateUploadDto;
    return dto.fileSize !== undefined || dto.partsCount !== undefined;
  }

  defaultMessage(): string {
    return 'Either fileSize or partsCount must be provided';
  }
}

/**
 * Body for `POST /videos/uploads`. Either `fileSize` (bytes, used to derive the
 * number of multipart parts) or `partsCount` (explicit part count) must be
 * provided; the service validates that at least one is present.
 */
export class InitiateUploadDto {
  /** Human-readable title of the video. */
  @IsString()
  @IsNotEmpty()
  @Validate(FileSizeOrPartsCountConstraint)
  title: string;

  /** MIME type of the source file (e.g. `video/mp4`). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  contentType?: string;

  /** Total size of the source file in bytes — used to derive the part count. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  fileSize?: number;

  /** Explicit number of multipart parts the client will upload. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  partsCount?: number;
}
