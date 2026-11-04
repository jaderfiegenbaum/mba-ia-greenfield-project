import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1793818645450 implements MigrationInterface {
  name = 'CreateVideos1793818645450';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channel_id" uuid NOT NULL, "public_id" character varying(11) NOT NULL, "title" character varying(100) NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "original_file_name" character varying(255) NOT NULL, "content_type" character varying(100) NOT NULL, "file_size" bigint NOT NULL, "storage_key" character varying(512) NOT NULL, "upload_id" character varying(255), "thumbnail_key" character varying(512), "duration_seconds" double precision, "metadata" jsonb, "processing_error" character varying(500), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_023a8e4f3f1a34ff3d8ca04a4c" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_39a1f0fe7991162aace659078e" ON "videos" ("public_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_39a1f0fe7991162aace659078e"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_023a8e4f3f1a34ff3d8ca04a4c"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
