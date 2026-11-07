// ============================================================================
//  EVIDENCE RECORDER — S3 Object Storage + PostgreSQL Metadata + Presigned URLs
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const EVIDENCE_DIR = path.join(__dirname, 'evidence');
const MAX_RECORDING_MS = 8 * 60 * 1000; // 8 minutes

// Lazy DB loader to avoid re-populating process.env during unit tests
function getDb() {
  try {
    return require('./db');
  } catch {
    return null;
  }
}

function getS3Client() {
  const bucket = process.env.S3_EVIDENCE_BUCKET;
  if (!bucket) return null;
  const region = process.env.AWS_REGION || 'ap-south-1';
  return new S3Client({ region });
}

// Ensure local evidence directory exists (for local mode / temp storage)
function ensureDir() {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
}

/**
 * Upload buffer or JSON directly to AWS S3.
 * Throws on failure so callers cannot silently report success.
 */
async function uploadToS3(key, body, contentType) {
  const bucket = process.env.S3_EVIDENCE_BUCKET;
  const client = getS3Client();
  if (!client || !bucket) return null;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ServerSideEncryption: 'AES256'
  });

  await client.send(command);

  const region = process.env.AWS_REGION || 'ap-south-1';
  const s3Url = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  console.log(`[EvidenceRecorder] ☁️ Uploaded to S3: ${key}`);
  return s3Url;
}

/**
 * Save evidence to S3 and record metadata in PostgreSQL.
 * Maintains local file write for test environments or when offline.
 */
async function saveEvidence(trackingId, audioBuffer, format = 'webm', userId = null) {
  if (
    typeof trackingId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(trackingId)
  ) {
    throw new Error('Invalid tracking ID');
  }

  ensureDir();

  const timestamp = Date.now();
  const fileName = `evidence_${trackingId}_${timestamp}.${format}`;
  const filePath = path.join(EVIDENCE_DIR, fileName);

  // Save local copy (for backward compatibility / offline tests)
  fs.writeFileSync(filePath, audioBuffer);

  // Calculate SHA-256
  const hash = crypto
    .createHash('sha256')
    .update(audioBuffer)
    .digest('hex');

  const s3Bucket = process.env.S3_EVIDENCE_BUCKET;
  const s3Client = getS3Client();
  let s3Url = null;
  let s3AudioKey = null;

  if (s3Client && s3Bucket) {
    s3AudioKey = `evidence/${trackingId}/${fileName}`;

    // Upload audio first. Failure propagates.
    s3Url = await uploadToS3(
      s3AudioKey,
      audioBuffer,
      `audio/${format}`
    );

    const metadata = {
      trackingId,
      fileName,
      format,
      sizeBytes: audioBuffer.length,
      sha256: hash,
      s3Url,
      createdAt: new Date().toISOString(),
      hashCalculated: true
    };

    const metadataPath = `${filePath}.json`;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    const s3MetaKey = `${s3AudioKey}.json`;

    try {
      await uploadToS3(
        s3MetaKey,
        JSON.stringify(metadata, null, 2),
        'application/json'
      );
    } catch (error) {
      console.error(
        `[EvidenceRecorder] Metadata upload failed: ${s3MetaKey}`
      );
      throw error;
    }

    // Persist to PostgreSQL if configured
    const db = getDb();
    if (db && db.isDatabaseConfigured()) {
      try {
        await db.prisma.evidenceObject.create({
          data: {
            trackingId,
            s3Key: s3AudioKey,
            s3Bucket: s3Bucket,
            fileName,
            fileFormat: format,
            sha256: hash,
            sizeBytes: audioBuffer.length,
            mimeType: `audio/${format}`,
            userId: userId || null,
            metadata
          }
        });
        console.log(`[EvidenceRecorder] 🗄️ Metadata persisted to PostgreSQL for tracking: ${trackingId}`);
      } catch (dbErr) {
        console.warn(`[EvidenceRecorder] PostgreSQL metadata persistence warning:`, dbErr.message);
      }
    }

    console.log(
      `[EvidenceRecorder] ✅ Audio and metadata persisted to S3: ${fileName}`
    );

    return {
      filePath,
      metadataPath,
      hash,
      fileName,
      s3Url,
      s3MetadataKey: s3MetaKey
    };
  }

  // Local-only mode
  const metadata = {
    trackingId,
    fileName,
    format,
    sizeBytes: audioBuffer.length,
    sha256: hash,
    s3Url: null,
    createdAt: new Date().toISOString(),
    hashCalculated: true
  };

  const metadataPath = `${filePath}.json`;
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  console.log(
    `[EvidenceRecorder] ✅ Evidence saved locally: ${fileName}`
  );

  return {
    filePath,
    metadataPath,
    hash,
    fileName,
    s3Url: null
  };
}

/**
 * Create a metadata-only record (e.g. for emergency resolution)
 */
async function createMetadata(trackingId, data) {
  ensureDir();

  const timestamp = Date.now();
  const fileName = `metadata_${trackingId}_${timestamp}.json`;
  const filePath = path.join(EVIDENCE_DIR, fileName);

  const record = {
    ...data,
    type: 'emergency_metadata',
    createdAt: new Date().toISOString()
  };

  const content = JSON.stringify(record, null, 2);
  fs.writeFileSync(filePath, content);

  if (process.env.S3_EVIDENCE_BUCKET) {
    await uploadToS3(`evidence/${trackingId}/${fileName}`, content, 'application/json');
  }
  return filePath;
}

/**
 * List all evidence for a tracking ID.
 * Reads from PostgreSQL metadata when available, with local disk fallback.
 */
async function listEvidence(trackingId) {
  const db = getDb();
  if (db && db.isDatabaseConfigured()) {
    try {
      const records = await db.prisma.evidenceObject.findMany({
        where: { trackingId },
        orderBy: { createdAt: 'desc' }
      });
      if (records && records.length > 0) {
        return records;
      }
    } catch (dbErr) {
      console.warn('[EvidenceRecorder] PostgreSQL list error, using local fallback:', dbErr.message);
    }
  }

  ensureDir();
  const files = fs.readdirSync(EVIDENCE_DIR);
  return files.filter(f => f.includes(trackingId));
}

/**
 * Generate an authorized, short-lived presigned URL for downloading evidence from S3.
 * Defaults to 15 minutes (900 seconds) expiration.
 */
async function getEvidenceDownloadUrl(trackingId, fileName, expiresIn = 900) {
  const s3Bucket = process.env.S3_EVIDENCE_BUCKET;
  const s3Client = getS3Client();
  if (!s3Client || !s3Bucket) {
    return null;
  }

  const s3Key = `evidence/${trackingId}/${fileName}`;
  const command = new GetObjectCommand({
    Bucket: s3Bucket,
    Key: s3Key
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn });
  return {
    downloadUrl: url,
    s3Key,
    expiresInSeconds: expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
  };
}

/**
 * Verify integrity of an evidence file against expected SHA-256
 */
function verifyIntegrity(fileName) {
  const filePath = path.join(EVIDENCE_DIR, fileName);
  const metadataPath = filePath + '.json';

  if (!fs.existsSync(filePath) || !fs.existsSync(metadataPath)) {
    return { valid: false, error: 'File or metadata not found' };
  }

  const audioBuffer = fs.readFileSync(filePath);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const computedHash = crypto.createHash('sha256').update(audioBuffer).digest('hex');

  return {
    valid: computedHash === metadata.sha256,
    expectedHash: metadata.sha256,
    computedHash,
    fileName
  };
}

module.exports = {
  saveEvidence,
  createMetadata,
  listEvidence,
  getEvidenceDownloadUrl,
  verifyIntegrity,
  EVIDENCE_DIR,
  MAX_RECORDING_MS
};
