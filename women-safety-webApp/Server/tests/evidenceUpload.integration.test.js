const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.S3_EVIDENCE_BUCKET = ''; // Keep empty so dotenv does not repopulate it from .env

const { app, server, io } = require('../index');
const { EVIDENCE_DIR } = require('../evidenceRecorder');

test('Evidence upload HTTP endpoint', async (t) => {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const createdFiles = [];

    try {
        await t.test('Missing evidence returns HTTP 400', async () => {
            const form = new FormData();
            form.append('trackingId', 'http_test');

            const response = await fetch(
                `${baseUrl}/api/upload-evidence`,
                { method: 'POST', body: form }
            );

            assert.equal(response.status, 400);

            const body = await response.json();
            assert.equal(body.success, false);
            assert.equal(body.error, 'No evidence file provided');
        });

        await t.test('Invalid tracking ID returns HTTP 400', async () => {
            const form = new FormData();
            form.append(
                'evidence',
                new Blob(['synthetic evidence']),
                'test.webm'
            );
            form.append('trackingId', '../invalid');

            const response = await fetch(
                `${baseUrl}/api/upload-evidence`,
                { method: 'POST', body: form }
            );

            assert.equal(response.status, 400);

            const body = await response.json();
            assert.equal(body.success, false);
            assert.equal(body.error, 'Invalid tracking ID');
        });

        await t.test('Valid synthetic evidence returns HTTP 200', async () => {
            const form = new FormData();
            form.append(
                'evidence',
                new Blob(['synthetic Sakhi evidence']),
                'test.webm'
            );
            form.append('trackingId', 'integration_test');

            const response = await fetch(
                `${baseUrl}/api/upload-evidence`,
                { method: 'POST', body: form }
            );

            assert.equal(response.status, 200);

            const body = await response.json();

            assert.equal(body.success, true);
            assert.ok(body.fileName);
            assert.ok(body.hash);
            assert.equal(body.s3Url, null);

            assert.ok(fs.existsSync(body.filePath));
            assert.ok(fs.existsSync(body.metadataPath));

            const metadata = JSON.parse(
                fs.readFileSync(body.metadataPath, 'utf8')
            );

            assert.equal(metadata.hashCalculated, true);
            assert.equal(metadata.trackingId, 'integration_test');

            createdFiles.push(body.filePath, body.metadataPath);
        });

    } finally {
        for (const file of createdFiles) {
            fs.rmSync(file, { force: true });
        }

        await new Promise((resolve) => {
            if (io && io.close) {
                io.close(() => resolve());
            } else if (server.listening) {
                server.close(() => resolve());
            } else {
                resolve();
            }
        });
    }
});
