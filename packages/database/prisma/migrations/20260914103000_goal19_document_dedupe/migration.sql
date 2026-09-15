CREATE UNIQUE INDEX "object_metadata_user_id_kind_checksum_sha256_key"
  ON "object_metadata"("userId", "kind", "checksumSha256");
