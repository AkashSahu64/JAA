CREATE UNIQUE INDEX "application_documents_applicationId_objectMetadataId_type_key"
ON "application_documents"("applicationId", "objectMetadataId", "type");
