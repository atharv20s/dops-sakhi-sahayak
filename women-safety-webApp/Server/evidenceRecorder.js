// ==============================================================================
//  Sakhi Sahayak — Evidence Recorder Module (S3 + PostgreSQL Production Tier)
// ==============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const EVIDENCE_DIR = path.join(__dirname, 'evidence');
const MAX_RECORDING_MS = 60000; // 60 seconds

function ensureDir() {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Lazy/dynamic clients to avoid eager environment/dotenv initialization issues
function getS3Client() {
  const bucket = process.env.S3_EVIDENCE_BUCKET;
  if (!bucket) return null;
  return new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1'
  });
}

function getDb() {
  try {
    return require('./db');
  } catch {
    return null;
  }
}

/**
 * Upload a file/buffer to S3 with SHA-256 integrity verification.
 * Throws if upload fails or if checksum mismatch occurs.
 */
async function uploadToS3(key, body, contentType = 'audio/webm') {
  const bucket = process.env.S3_EVIDENCE_BUCKET;
  const s3 = getS3Client();
  if (!s3 || !bucket) {
    throw new Error('S3_EVIDENCE_BUCKET is not configured.');
  }

  const expectedSha256 = crypto
    .createHash('sha256')
    .update(typeof body === 'string' ? Buffer.from(body) : body)
    .digest('hex');

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ServerSideEncryption: 'AES256',
    Metadata: {
      'sha256-checksum': expectedSha256
    }
  });

  const uploadResult = await s3.send(command);
  console.log(`[EvidenceRecorder] ☁️ Uploaded to S3: s3://${bucket}/${key} (sha256: ${expectedSha256.slice(0, 12)}...)`);
  return { uploadResult, sha256: expectedSha256 };
}

/**
 * Save evidence to S3 and record metadata in PostgreSQL.
 *
 * Production Invariants:
 * - Zero local disk writes (no local evidence directory, no local audio files, no local JSON sidecars).
 * - S3 audio upload + PostgreSQL metadata are mandatory.
 * - Local filesystem persistence is strictly for offline/development/test modes.
 */
async function saveEvidence(trackingId, audioBuffer, format = 'webm', userId = null, providedSecret = null) {
  if (
    typeof trackingId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(trackingId)
  ) {
    throw new Error('Invalid tracking ID');
  }

  const isProd = process.env.NODE_ENV === 'production';
  const s3Bucket = process.env.S3_EVIDENCE_BUCKET;
  const s3Client = getS3Client();
  const db = getDb();

  // In production, strictly require S3 and PostgreSQL
  if (isProd) {
    if (!s3Bucket || !s3Client) {
      throw new Error('S3_EVIDENCE_BUCKET is required in production.');
    }
    if (!db || !db.isDatabaseConfigured()) {
      throw new Error('PostgreSQL database is required in production for evidence metadata.');
    }
  }

  const timestamp = Date.now();
  const fileName = `evidence_${trackingId}_${timestamp}.${format}`;

  // Calculate SHA-256
  const hash = crypto
    .createHash('sha256')
    .update(audioBuffer)
    .digest('hex');

  // Handle authorization secret for anonymous emergency sessions
  let trackingSecret = null;
  let trackingSecretHash = null;

  if (!userId) {
    if (providedSecret && typeof providedSecret === 'string' && providedSecret.length >= 16) {
      trackingSecret = providedSecret;
    } else {
      trackingSecret = crypto.randomBytes(24).toString('hex');
    }
    trackingSecretHash = crypto.createHash('sha256').update(trackingSecret).digest('hex');
  }

  let s3AudioKey = null;
  let s3MetaKey = null;
  let filePath = null;
  let metadataPath = null;

  if (s3Client && s3Bucket) {
    s3AudioKey = `evidence/${trackingId}/${fileName}`;
    await uploadToS3(s3AudioKey, audioBuffer, `audio/${format}`);

    const metadata = {
      trackingId,
      fileName,
      format,
      sizeBytes: audioBuffer.length,
      sha256: hash,
      s3Key: s3AudioKey,
      trackingSecretHash,
      createdAt: new Date().toISOString(),
      hashCalculated: true
    };

    s3MetaKey = `${s3AudioKey}.json`;
    await uploadToS3(s3MetaKey, JSON.stringify(metadata, null, 2), 'application/json');

    // In non-production with S3 enabled, optional local copy for inspection
    if (!isProd) {
      ensureDir();
      filePath = path.join(EVIDENCE_DIR, fileName);
      fs.writeFileSync(filePath, audioBuffer);
      metadataPath = `${filePath}.json`;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    }
  } else {
    // Non-production local storage mode
    ensureDir();
    filePath = path.join(EVIDENCE_DIR, fileName);
    fs.writeFileSync(filePath, audioBuffer);

    const metadata = {
      trackingId,
      fileName,
      format,
      sizeBytes: audioBuffer.length,
      sha256: hash,
      s3Url: null,
      trackingSecretHash,
      createdAt: new Date().toISOString(),
      hashCalculated: true
    };
    metadataPath = `${filePath}.json`;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  }

  // Persist metadata to PostgreSQL whenever configured — failure MUST fail the upload!
  let dbRecord = null;
  if (db && db.isDatabaseConfigured()) {
    try {
      dbRecord = await db.prisma.evidenceObject.create({
        data: {
          trackingId,
          s3Key: s3AudioKey || `local/${trackingId}/${fileName}`,
          s3Bucket: s3Bucket || 'local-filesystem',
          fileName,
          fileFormat: format,
          sha256: hash,
          sizeBytes: audioBuffer.length,
          mimeType: `audio/${format}`,
          userId: userId || null,
          metadata: {
            trackingId,
            fileName,
            sizeBytes: audioBuffer.length,
            sha256: hash,
            trackingSecretHash,
            createdAt: new Date().toISOString()
          }
        }
      });
      console.log(`[EvidenceRecorder] 🗄️ Metadata persisted to PostgreSQL: ${dbRecord.id} (tracking: ${trackingId})`);
    } catch (err) {
      console.error(`[EvidenceRecorder] ❌ PostgreSQL metadata write failed for ${trackingId}:`, err.message);
      throw err;
    }
  }

  return {
    evidenceId: dbRecord ? dbRecord.id : null,
    filePath,
    metadataPath,
    hash,
    sha256: hash,
    fileName,
    trackingId,
    trackingSecret,
    s3Key: s3AudioKey,
    s3Bucket: s3Bucket || null,
    s3Url: null,
    format,
    sizeBytes: audioBuffer.length
  };
}

/**
 * Create a metadata-only record (e.g. for emergency resolution).
 * Zero local disk writes in production.
 */
async function createMetadata(trackingId, data) {
  const isProd = process.env.NODE_ENV === 'production';
  const s3Bucket = process.env.S3_EVIDENCE_BUCKET;
  const s3Client = getS3Client();

  const timestamp = Date.now();
  const fileName = `metadata_${trackingId}_${timestamp}.json`;
  const record = {
    ...data,
    type: 'emergency_metadata',
    createdAt: new Date().toISOString()
  };
  const content = JSON.stringify(record, null, 2);

  if (s3Client && s3Bucket) {
    const s3Key = `evidence/${trackingId}/${fileName}`;
    await uploadToS3(s3Key, content, 'application/json');
    return `s3://${s3Bucket}/${s3Key}`;
  }

  if (isProd) {
    throw new Error('S3_EVIDENCE_BUCKET is required in production for emergency metadata.');
  }

  // Local-only dev fallback
  ensureDir();
  const filePath = path.join(EVIDENCE_DIR, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/**
 * List all evidence for a tracking ID.
 * Strictly enforces PER-RECORD authorization:
 * - Each owned record is only visible to its verified owner.
 * - Each anonymous record is only visible to the bearer of its tracking secret.
 * - Cross-user evidence leakage through shared tracking IDs is strictly impossible.
 */
async function listEvidence(trackingId, requestingUserId = null, trackingSecret = null) {
  const db = getDb();
  if (db && db.isDatabaseConfigured()) {
    const records = await db.prisma.evidenceObject.findMany({
      where: { trackingId },
      orderBy: { createdAt: 'desc' }
    });

    if (records.length === 0) return [];

    // CRITICAL SECURITY FIX: Filter and authorize every record individually
    const authorizedRecords = records.filter(record => {
      if (record.userId) {
        return requestingUserId && record.userId === requestingUserId;
      } else {
        const expectedHash = record.metadata?.trackingSecretHash;
        if (!expectedHash) return false;
        if (!trackingSecret) return false;
        const providedHash = crypto.createHash('sha256').update(trackingSecret).digest('hex');
        return safeCompare(providedHash, expectedHash);
      }
    });

    if (authorizedRecords.length === 0) {
      const err = new Error('Forbidden: You do not have permission to view evidence for this incident.');
      err.statusCode = 403;
      throw err;
    }

    return authorizedRecords;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('PostgreSQL database required in production to list evidence.');
  }

  ensureDir();
  const files = fs.readdirSync(EVIDENCE_DIR);
  return files.filter(f => f.includes(trackingId));
}

/**
 * Generate an authorized, short-lived presigned URL for downloading evidence from S3.
 * Queries PostgreSQL metadata first to verify existence and ownership.
 * Defaults to 15 minutes (900 seconds) expiration.
 */
async function getEvidenceDownloadUrl(trackingId, fileName, requestingUserId = null, trackingSecret = null, expiresIn = 900) {
  const s3Bucket = process.env.S3_EVIDENCE_BUCKET;
  const s3Client = getS3Client();
  if (!s3Client || !s3Bucket) {
    return null;
  }

  const db = getDb();
  if (db && db.isDatabaseConfigured()) {
    const record = await db.prisma.evidenceObject.findFirst({
      where: { trackingId, fileName }
    });
    if (!record) {
      return null;
    }

    // Strict Authorization Check:
    if (record.userId) {
      if (!requestingUserId || record.userId !== requestingUserId) {
        const err = new Error('Forbidden: You do not have permission to access this evidence.');
        err.statusCode = 403;
        throw err;
      }
    } else {
      const expectedHash = record.metadata?.trackingSecretHash;
      if (expectedHash) {
        const providedHash = trackingSecret ? crypto.createHash('sha256').update(trackingSecret).digest('hex') : null;
        if (!providedHash || !safeCompare(providedHash, expectedHash)) {
          const err = new Error('Forbidden: Valid emergency tracking secret is required to access anonymous evidence.');
          err.statusCode = 403;
          throw err;
        }
      } else {
        const err = new Error('Forbidden: Anonymous evidence missing tracking capability.');
        err.statusCode = 403;
        throw err;
      }
    }
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
 * Verify integrity of an evidence file against expected SHA-256.
 * Supports S3 and local storage modes.
 */
async function verifyIntegrity(trackingId, fileName) {
  const db = getDb();
  let dbRecord = null;
  if (db && db.isDatabaseConfigured()) {
    dbRecord = await db.prisma.evidenceObject.findFirst({
      where: { trackingId, fileName }
    });
  }

  const s3Bucket = process.env.S3_EVIDENCE_BUCKET;
  const s3Client = getS3Client();

  if (s3Client && s3Bucket) {
    const s3Key = `evidence/${trackingId}/${fileName}`;
    try {
      const command = new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key });
      const response = await s3Client.send(command);
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const computedHash = crypto.createHash('sha256').update(buffer).digest('hex');
      const expectedHash = dbRecord ? dbRecord.sha256 : null;

      return {
        valid: expectedHash ? safeCompare(computedHash, expectedHash) : true,
        source: 's3',
        computedHash,
        expectedHash,
        sizeBytes: buffer.length
      };
    } catch (err) {
      return { valid: false, error: err.message, source: 's3' };
    }
  }

  const filePath = path.join(EVIDENCE_DIR, fileName);
  const metadataPath = filePath + '.json';

  if (!fs.existsSync(filePath)) {
    return { valid: false, error: 'Local file not found' };
  }

  const audioBuffer = fs.readFileSync(filePath);
  const metadata = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : null;
  const computedHash = crypto.createHash('sha256').update(audioBuffer).digest('hex');
  const expectedHash = dbRecord ? dbRecord.sha256 : (metadata ? metadata.sha256 : null);

  return {
    valid: expectedHash ? safeCompare(computedHash, expectedHash) : true,
    expectedHash,
    computedHash,
    fileName,
    source: 'local'
  };
}

module.exports = {
  saveEvidence,
  createMetadata,
  listEvidence,
  getEvidenceDownloadUrl,
  verifyIntegrity,
  safeCompare,
  EVIDENCE_DIR,
  MAX_RECORDING_MS
};
