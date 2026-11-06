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
 * Upload buffer or JSON directly to AWS S3
 */
async function uploadToS3(key, body, contentType) {
  if (!s3Client || !S3_BUCKET_NAME) return null;
  try {
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: 'AES256'
    });
    await s3Client.send(command);
    const s3Url = `https://${S3_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;
    console.log(`[EvidenceRecorder] ☁️ Uploaded to S3: ${s3Url}`);
    return s3Url;
  } catch (err) {
    console.error(`[EvidenceRecorder] ❌ S3 upload failed for ${key}:`, err.message);
    return null;
  }
}

/**
 * Save an evidence audio file (Local disk + AWS S3 backup)
 */
async function saveEvidence(trackingId, audioBuffer, format = 'webm') {
  ensureDir();

  const timestamp = Date.now();
  const fileName = `evidence_${trackingId}_${timestamp}.${format}`;
  const filePath = path.join(EVIDENCE_DIR, fileName);

  // Write audio locally
  fs.writeFileSync(filePath, audioBuffer);

  // Compute SHA-256 hash for forensic chain of custody
  const hash = crypto.createHash('sha256').update(audioBuffer).digest('hex');

  // Async push to AWS S3 if active
  const s3AudioKey = `evidence/${trackingId}/${fileName}`;
  const s3Url = await uploadToS3(s3AudioKey, audioBuffer, `audio/${format}`);

  // Write metadata sidecar
  const metadata = {
    trackingId,
    fileName,
    format,
    sizeBytes: audioBuffer.length,
    sha256: hash,
    s3Url: s3Url || null,
    createdAt: new Date().toISOString(),
    integrityVerified: true
  };

  const metadataPath = filePath + '.json';
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  // Also push metadata JSON to S3
  const s3MetaKey = `evidence/${trackingId}/${fileName}.json`;
  await uploadToS3(s3MetaKey, JSON.stringify(metadata, null, 2), 'application/json');

  console.log(`[EvidenceRecorder] ✅ Evidence saved: ${fileName} (${(audioBuffer.length / 1024).toFixed(1)} KB)`);
  return { filePath, metadataPath, hash, fileName, s3Url };
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
