// ============================================================================
//  EVIDENCE RECORDER — Hybrid Local & AWS S3 Storage with SHA-256 Integrity
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const EVIDENCE_DIR = path.join(__dirname, 'evidence');
const MAX_RECORDING_MS = 8 * 60 * 1000; // 8 minutes

// AWS S3 Client setup if configured in environment
const AWS_REGION = process.env.AWS_REGION || 'ap-south-1';
const S3_BUCKET_NAME = process.env.S3_EVIDENCE_BUCKET;

let s3Client = null;
if (S3_BUCKET_NAME) {
  s3Client = new S3Client({ region: AWS_REGION });
  console.log(`[EvidenceRecorder] ☁️ AWS S3 Uploads Enabled (Bucket: ${S3_BUCKET_NAME})`);
} else {
  console.log('[EvidenceRecorder] 📁 AWS S3 not configured. Operating in local storage mode.');
}

// Ensure local evidence directory exists
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
  if (!s3Client || !S3_BUCKET_NAME) return null;

  const command = new PutObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
    ServerSideEncryption: 'AES256'
  });

  await s3Client.send(command);

  const s3Url = `https://${S3_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;
  console.log(`[EvidenceRecorder] ☁️ Uploaded to S3: ${key}`);
  return s3Url;
}

/**
 * Save evidence locally and upload audio + metadata to S3.
 * Success in S3 mode means BOTH objects were uploaded.
 */
async function saveEvidence(trackingId, audioBuffer, format = 'webm') {
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

  // Save local copy
  fs.writeFileSync(filePath, audioBuffer);

  // Calculate SHA-256
  const hash = crypto
    .createHash('sha256')
    .update(audioBuffer)
    .digest('hex');

  let s3Url = null;

  if (s3Client && S3_BUCKET_NAME) {
    const s3AudioKey = `evidence/${trackingId}/${fileName}`;

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

    fs.writeFileSync(
      metadataPath,
      JSON.stringify(metadata, null, 2)
    );

    const s3MetaKey = `${s3AudioKey}.json`;

    try {
      // Metadata must also upload successfully.
      await uploadToS3(
        s3MetaKey,
        JSON.stringify(metadata, null, 2),
        'application/json'
      );
    } catch (error) {
      console.error(
        `[EvidenceRecorder] Metadata upload failed. Audio object may remain in S3: ${s3AudioKey}`
      );
      throw error;
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

  fs.writeFileSync(
    metadataPath,
    JSON.stringify(metadata, null, 2)
  );

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

  await uploadToS3(`evidence/${trackingId}/${fileName}`, content, 'application/json');
  return filePath;
}

/**
 * List all evidence files for a tracking ID
 */
function listEvidence(trackingId) {
  ensureDir();
  const files = fs.readdirSync(EVIDENCE_DIR);
  return files.filter(f => f.includes(trackingId));
}

/**
 * Verify integrity of an evidence file
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
  verifyIntegrity,
  EVIDENCE_DIR,
  MAX_RECORDING_MS
};
