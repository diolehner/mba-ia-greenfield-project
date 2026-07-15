import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1780000000000 implements MigrationInterface {
  name = 'CreateVideos1780000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'uploaded', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channelId" uuid NOT NULL, "publicId" character varying NOT NULL, "title" character varying NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "storageKey" character varying NOT NULL, "thumbnailKey" character varying, "uploadId" character varying, "mimeType" character varying, "sizeBytes" bigint, "durationSeconds" integer, "metadata" jsonb, "failureReason" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_videos_publicId" UNIQUE ("publicId"), CONSTRAINT "PK_videos_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_channelId" ON "videos" ("channelId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_videos_channelId" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_videos_channelId"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_channelId"`);
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
