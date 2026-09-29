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

/**
 * Мэдэгдлийн хавсралтад зориулсан PRIVATE container.
 * Azure Portal → Storage account → Containers → "+ Container"
 *   Name: notification-attachments, Anonymous access level: Private
 */
const CONTAINER =
  process.env.AZURE_STORAGE_NOTIFICATIONS_CONTAINER || 'notification-attachments';

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

function isZip(b) {
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/**
 * Зөвшөөрөгдөх төрлүүд. SVG санаатайгаар ОРООГҮЙ (дотор нь script байж болно).
 * magic — файлын эхний байтуудаар жинхэнэ төрлийг шалгана.
 */
const ALLOWED_TYPES = {
  'image/png': {
    ext: 'png',
    inline: true,
    magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/jpeg': { ext: 'jpg', inline: true, magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': {
    ext: 'webp',
    inline: true,
    magic: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  },
  'application/pdf': { ext: 'pdf', inline: true, magic: (b) => b.toString('latin1', 0, 5) === '%PDF-' },
  // Office файлууд нь дотроо ZIP ("PK\x03\x04")
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: 'docx', inline: false, magic: isZip },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: 'xlsx', inline: false, magic: isZip },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { ext: 'pptx', inline: false, magic: isZip },
};

const BLOB_PATH_PATTERN = /^notifications\/[0-9a-f-]{36}\.(png|jpg|webp|pdf|docx|xlsx|pptx)$/;

class BlobConfigError extends Error {
  constructor() {
    super('Azure Blob Storage тохиргоо дутуу байна (.env-ийн AZURE_STORAGE_* хэсгийг шалгана уу).');
    this.name = 'BlobConfigError';
    this.statusCode = 503;
  }
}

function getClient() {
  const { accountName, accountKey } = env.azureStorage;
  if (!accountName || !accountKey) throw new BlobConfigError();
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const serviceClient = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential);
  return { serviceClient, credential, accountName };
}

function isAllowedType(contentType) {
  return typeof contentType === 'string' && Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, contentType);
}

function isValidAttachmentBlobPath(blobPath, contentType) {
  if (typeof blobPath !== 'string' || !BLOB_PATH_PATTERN.test(blobPath)) return false;
  // Замын өргөтгөл нь зарласан төрөлтэй таарах ёстой
  return isAllowedType(contentType) && blobPath.endsWith(`.${ALLOWED_TYPES[contentType].ext}`);
}

/** Browser-оос шууд upload хийх 10 минутын write-only SAS. */
function generateAttachmentUploadUrl(contentType) {
  const { credential, accountName } = getClient();
  const blobPath = `notifications/${crypto.randomUUID()}.${ALLOWED_TYPES[contentType].ext}`;

  const sas = generateBlobSASQueryParameters(
    {
      containerName: CONTAINER,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse('cw'),
      startsOn: new Date(Date.now() - 60 * 1000),
      expiresOn: new Date(Date.now() + 10 * 60 * 1000),
    },
    credential
  ).toString();

  return {
    uploadUrl: `https://${accountName}.blob.core.windows.net/${CONTAINER}/${blobPath}?${sas}`,
    blobPath,
  };
}

/**
 * 15 минутын read-only SAS. Зураг/PDF browser дотор нээгдэнэ, Office
 * файл татагдана. Файлын нэр нь анхны нэрээрээ харагдана.
 */
function generateAttachmentReadUrl(blobPath, fileName, contentType) {
  const { credential, accountName } = getClient();
  const type = ALLOWED_TYPES[contentType];
  const safeName =
    String(fileName || 'file').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 150) || 'file';
  const disposition = `${type && type.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(safeName)}`;

  const sas = generateBlobSASQueryParameters(
    {
      containerName: CONTAINER,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse('r'),
      startsOn: new Date(Date.now() - 60 * 1000),
      expiresOn: new Date(Date.now() + 15 * 60 * 1000),
      contentType,
      contentDisposition: disposition,
    },
    credential
  ).toString();

  return `https://${accountName}.blob.core.windows.net/${CONTAINER}/${blobPath}?${sas}`;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function deleteAttachmentBlob(blobPath) {
  try {
    const { serviceClient } = getClient();
    await serviceClient.getContainerClient(CONTAINER).getBlobClient(blobPath).deleteIfExists();
  } catch (err) {
    logger.error('Хавсралтын blob устгаж чадсангүй', { blobPath, error: err?.message });
  }
}

/**
 * Upload хийгдсэн blob-ийг шалгана: байгаа эсэх, жинхэнэ хэмжээ,
 * эхний байтууд зарласан төрөлтэй таарах эсэх.
 * @returns {Promise<{ ok: true, size: number } | { ok: false, error: string }>}
 */
async function verifyAttachmentBlob(blobPath, contentType) {
  const { serviceClient } = getClient();
  const blobClient = serviceClient.getContainerClient(CONTAINER).getBlobClient(blobPath);

  let props;
  try {
    props = await blobClient.getProperties();
  } catch (err) {
    if (err && err.statusCode === 404) {
      return { ok: false, error: 'Хавсралт байршуулагдаагүй байна. Дахин оролдоно уу.' };
    }
    throw err;
  }

  const size = props.contentLength || 0;
  if (size === 0 || size > MAX_ATTACHMENT_SIZE) {
    await deleteAttachmentBlob(blobPath);
    return { ok: false, error: 'Хавсралтын хэмжээ 10MB-с хэтэрсэн байна.' };
  }

  const head = await blobClient.download(0, 12);
  const bytes = head.readableStreamBody ? await streamToBuffer(head.readableStreamBody) : Buffer.alloc(0);
  if (bytes.length < 4 || !ALLOWED_TYPES[contentType].magic(bytes)) {
    await deleteAttachmentBlob(blobPath);
    return { ok: false, error: 'Хавсралтын файлын төрөл зөвшөөрөгдөөгүй эсвэл эвдэрсэн байна.' };
  }

  return { ok: true, size };
}

module.exports = {
  MAX_ATTACHMENT_SIZE,
  isAllowedType,
  isValidAttachmentBlobPath,
  generateAttachmentUploadUrl,
  generateAttachmentReadUrl,
  verifyAttachmentBlob,
  deleteAttachmentBlob,
};