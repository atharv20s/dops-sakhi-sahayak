const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const evidenceRecorderPath = require.resolve('../evidenceRecorder');

test('Evidence recorder local storage and SHA-256 verification', async (t) => {
    // Ensure this test exercises local mode, not AWS.
    delete process.env.S3_EVIDENCE_BUCKET;

    delete require.cache[evidenceRecorderPath];

    const {
        saveEvidence,
        EVIDENCE_DIR
    } = require('../evidenceRecorder');

    const trackingId = `local_test_${Date.now()}`;
    const audioBuffer = Buffer.from(
        'Synthetic Sakhi Sahayak evidence test'
    );

    const expectedHash = crypto
        .createHash('sha256')
        .update(audioBuffer)
        .digest('hex');

    await t.test('Valid evidence is saved locally', async () => {
        const result = await saveEvidence(
            trackingId,
            audioBuffer,
            'webm'
        );

        assert.ok(fs.existsSync(result.filePath));
        assert.ok(fs.existsSync(result.metadataPath));

        const savedAudio = fs.readFileSync(result.filePath);
        assert.deepEqual(savedAudio, audioBuffer);

        const metadata = JSON.parse(
            fs.readFileSync(result.metadataPath, 'utf8')
        );

        assert.equal(metadata.trackingId, trackingId);
        assert.equal(metadata.sha256, expectedHash);
        assert.equal(metadata.hashCalculated, true);
        assert.equal(metadata.s3Url, null);
        assert.equal(result.hash, expectedHash);

        console.log('PASS: Local storage and SHA-256');

        fs.rmSync(result.filePath);
        fs.rmSync(result.metadataPath);
    });

    await t.test('Invalid tracking IDs are rejected', async () => {
        await assert.rejects(
            saveEvidence('../invalid', audioBuffer, 'webm'),
            /Invalid tracking ID/
        );

        console.log('PASS: Invalid tracking ID rejected');
    });

    // Clean up test-created files if a test fails.
    if (fs.existsSync(EVIDENCE_DIR)) {
        for (const file of fs.readdirSync(EVIDENCE_DIR)) {
            if (file.includes(trackingId)) {
                fs.rmSync(path.join(EVIDENCE_DIR, file), {
                    force: true
                });
            }
        }
    }
});
