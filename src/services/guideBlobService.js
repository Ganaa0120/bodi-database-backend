'use strict';

const crypto = require('crypto');
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require('@azure/storage-blob');
const env = require('../config/env');
const logger = require('../utils/logger');

class BlobConfigError extends Error {
  constructor() {
    super('Azure Blob Storage тохиргоо дутуу байна (.env-ийн AZURE_STORAGE_* хэсгийг шалгана уу).');
    this.name = 'BlobConfigError';
    this.statusCode = 503;
  }
}

/**
 * Системийн заавар (PDF)-д зориулсан PRIVATE container.
 * Logo-ийн container шиг public БИШ — унших бүрт backend эрх шалгаад
 * 15 минутын read SAS үүсгэнэ.
 *
 * Azure Portal → Storage account → Containers → "+ Container"
 *   Name: system-guides, Anonymous access level: Private
 */
const GUIDES_CONTAINER = process.env.AZURE_STORAGE_GUIDES_CONTAINER || 'system-guides';

const BLOB_PATH_PATTERN = /^guides\/[0-9a-f-]{36}-[a-z0-9.\-_]+\.pdf$/;

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
  return { serviceClient, credential, accountName };
}

function sanitizeFileName(fileName) {
  const base = fileName
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .replace(/[^a-z0-9.\-_]/g, '-')
    .replace(/-+/g, '-')
    .slice(-60);
  return `${base || 'guide'}.pdf`;
}

/** blob_path нь зөвхөн энэ service-ийн үүсгэсэн хэлбэртэй эсэх. */
function isValidGuideBlobPath(blobPath) {
  return typeof blobPath === 'string' && BLOB_PATH_PATTERN.test(blobPath);
}

/**
 * Browser-оос шууд upload хийх 10 минутын write-only SAS.
 * @returns {{ uploadUrl: string, blobPath: string }}
 */
function generateGuideUploadUrl(originalFileName) {
  const { credential, accountName } = getClient();
  const blobPath = `guides/${crypto.randomUUID()}-${sanitizeFileName(originalFileName)}`;

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName: GUIDES_CONTAINER,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse('cw'),
      startsOn: new Date(Date.now() - 60 * 1000),
      expiresOn: new Date(Date.now() + 10 * 60 * 1000),
    },
    credential
  ).toString();

  return {
    uploadUrl: `https://${accountName}.blob.core.windows.net/${GUIDES_CONTAINER}/${blobPath}?${sasToken}`,
    blobPath,
  };
}

/**
 * 15 минутын read-only SAS. Browser PDF-ийг татахгүйгээр шууд харуулна
 * (Content-Disposition: inline), файлын нэр нь зааврын гарчиг байна.
 */
function generateGuideReadUrl(blobPath, title) {
  const { credential, accountName } = getClient();

  const safeTitle = String(title || 'guide').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 120);
  const contentDisposition = `inline; filename*=UTF-8''${encodeURIComponent(safeTitle)}.pdf`;

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName: GUIDES_CONTAINER,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse('r'),
      startsOn: new Date(Date.now() - 60 * 1000),
      expiresOn: new Date(Date.now() + 15 * 60 * 1000),
      contentType: 'application/pdf',
      contentDisposition,
    },
    credential
  ).toString();

  return `https://${accountName}.blob.core.windows.net/${GUIDES_CONTAINER}/${blobPath}?${sasToken}`;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Upload хийгдсэн blob-ийг шалгана. Client-ийн хэлсэн хэмжээнд итгэхгүй —
 * жинхэнэ хэмжээг Azure-аас авч, эхний байтууд "%PDF-" мөн эсэхийг харна.
 *
 * @returns {Promise<{ exists: false } | { exists: true, size: number, isPdf: boolean }>}
 */
async function inspectGuideBlob(blobPath) {
  const { serviceClient } = getClient();
  const blobClient = serviceClient.getContainerClient(GUIDES_CONTAINER).getBlobClient(blobPath);

  let props;
  try {
    props = await blobClient.getProperties();
  } catch (err) {
    if (err && err.statusCode === 404) return { exists: false };
    throw err;
  }

  const head = await blobClient.download(0, 5);
  const bytes = head.readableStreamBody ? await streamToBuffer(head.readableStreamBody) : Buffer.alloc(0);

  return {
    exists: true,
    size: props.contentLength || 0,
    isPdf: bytes.toString('latin1') === '%PDF-',
  };
}

/** Алдаа гарсан ч throw хийхгүй — зөвхөн log бичнэ. */
async function deleteGuideBlob(blobPath) {
  try {
    const { serviceClient } = getClient();
    await serviceClient.getContainerClient(GUIDES_CONTAINER).getBlobClient(blobPath).deleteIfExists();
  } catch (err) {
    logger.error('Guide blob устгаж чадсангүй', { blobPath, error: err?.message });
  }
}

module.exports = {
  isValidGuideBlobPath,
  generateGuideUploadUrl,
  generateGuideReadUrl,
  inspectGuideBlob,
  deleteGuideBlob,
};