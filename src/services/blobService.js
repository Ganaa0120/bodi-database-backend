'use strict';

const crypto = require('crypto');
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require('@azure/storage-blob');
const env = require('../config/env');

class BlobConfigError extends Error {
  constructor() {
    super('Azure Blob Storage тохиргоо дутуу байна (.env-ийн AZURE_STORAGE_* хэсгийг шалгана уу).');
    this.name = 'BlobConfigError';
    this.statusCode = 503;
  }
}

function getClient() {
  const { accountName, accountKey } = env.azureStorage;
  if (!accountName || !accountKey) {
    throw new BlobConfigError();
  }
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const serviceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential
  );
  return { serviceClient, credential };
}

function sanitizeFileName(fileName) {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]/g, '-')
    .slice(-80);
}

/**
 * Browser-с шууд Azure Blob руу (backend server дамжихгүйгээр) upload
 * хийх боломж олгох, богино хугацаанд (10 минут) хүчинтэй, зөвхөн энэ
 * ганц blob-д бичих эрхтэй SAS URL үүсгэнэ.
 *
 * @returns {{ uploadUrl: string, publicUrl: string }}
 */
function generateUploadUrl(originalFileName, contentType) {
  const { credential } = getClient();
  const { accountName, container } = env.azureStorage;

  const blobName = `${crypto.randomUUID()}-${sanitizeFileName(originalFileName)}`;

  const expiresOn = new Date(Date.now() + 10 * 60 * 1000);
  const sasToken = generateBlobSASQueryParameters(
    {
      containerName: container,
      blobName,
      permissions: BlobSASPermissions.parse('cw'), // create + write, унших эрхгүй (upload-д зориулагдсан)
      startsOn: new Date(Date.now() - 60 * 1000), // clock skew-с сэргийлж 1 мин өмнөөс
      expiresOn,
      contentType,
    },
    credential
  ).toString();

  const baseUrl = `https://${accountName}.blob.core.windows.net/${container}/${blobName}`;

  return {
    uploadUrl: `${baseUrl}?${sasToken}`,
    // Container "Public access: Blob" тул SAS-гүйгээр унших боломжтой байнгын URL
    publicUrl: baseUrl,
  };
}

module.exports = { generateUploadUrl, BlobConfigError };