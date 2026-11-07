const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.S3_EVIDENCE_BUCKET = '';

const { app, server, io } = require('../index');

let baseUrl;

test('health endpoints return healthy responses', async (t) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    for (const path of ['/health', '/api/health']) {
      await t.test(`GET ${path}`, async () => {
        const response = await fetch(`${baseUrl}${path}`);

        assert.equal(response.status, 200);

        const body = await response.json();

        assert.equal(body.status, 'healthy');
        assert.equal(body.service, 'sakhi-backend');
        assert.equal(typeof body.uptime, 'number');
        assert.ok(body.uptime >= 0);
        assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
      });
    }
  } finally {
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
