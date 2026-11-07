const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const EmbeddedPostgres = require('embedded-postgres').default;

const PG_PORT = 5433;
const PG_URL = `postgresql://postgres:password@localhost:${PG_PORT}/postgres?schema=public`;

test('PostgreSQL End-to-End Integration & Persistence Suite', async (t) => {
  // 1. Initialize and start Embedded PostgreSQL
  const pg = new EmbeddedPostgres({ port: PG_PORT });
  await pg.start();

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = PG_URL;
  process.env.S3_EVIDENCE_BUCKET = ''; // Local storage mode for evidence integration test

  const { prisma, checkDatabaseHealth } = require('../db');
  const { app, server, io } = require('../index');
  const { saveEvidence, listEvidence } = require('../evidenceRecorder');

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let createdEvidenceId = null;
  const testPhone = `9811${Date.now().toString().slice(-6)}`;
  let registeredUserId = null;
  let userToken = null;

  t.after(async () => {
    await new Promise((resolve) => {
      if (io && io.close) io.close(() => resolve());
      else resolve();
    });
    await new Promise((resolve) => {
      if (server.listening) server.close(() => resolve());
      else resolve();
    });
    await prisma.$disconnect();
    await pg.stop();
  });

  // ── Test 1: Readiness probe confirms PostgreSQL is connected ──
  await t.test('GET /ready confirms PostgreSQL is connected with latency metric', async () => {
    const res = await fetch(`${baseUrl}/ready`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ready');
    assert.equal(data.database, 'connected');
    assert.ok(typeof data.latencyMs === 'number');
    assert.ok(data.latencyMs >= 0);
  });

  // ── Test 2: User registration persists to PostgreSQL with bcrypt hash and token ──
  await t.test('User registration persists directly to PostgreSQL users table', async () => {
    const signupRes = await fetch(`${baseUrl}/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName: 'Priya Deshmukh',
        userPhone: testPhone,
        userPassword: 'SecurePassword@2026',
        emergencyName: 'Amit Deshmukh',
        emergencyPhone: '9822001122'
      })
    });

    assert.equal(signupRes.status, 201);
    const signupData = await signupRes.json();
    assert.equal(signupData.success, true);
    assert.ok(signupData.token, 'Must return JWT/session token');
    assert.equal(signupData.user.name, 'Priya Deshmukh');
    assert.equal(signupData.user.phone, testPhone);
    assert.equal(signupData.user.password, undefined);
    assert.equal(signupData.user.passwordHash, undefined);
    userToken = signupData.token;

    // Verify record in PostgreSQL directly via Prisma
    const dbUser = await prisma.user.findUnique({ where: { phone: testPhone } });
    assert.ok(dbUser, 'User must exist in PostgreSQL users table');
    assert.equal(dbUser.name, 'Priya Deshmukh');
    assert.ok(dbUser.passwordHash.startsWith('$2'), 'Password hash must be valid bcrypt');
    assert.notEqual(dbUser.passwordHash, 'SecurePassword@2026', 'Password must never be plaintext');
    registeredUserId = dbUser.id;

    // Duplicate signup must fail
    const dupRes = await fetch(`${baseUrl}/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName: 'Duplicate Priya',
        userPhone: testPhone,
        userPassword: 'AnotherPassword123'
      })
    });
    assert.equal(dupRes.status, 400);
  });

  // ── Test 3: User login validates bcrypt password against PostgreSQL ──
  await t.test('User login validates bcrypt password against PostgreSQL', async () => {
    const loginRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userPhone: testPhone,
        userPassword: 'SecurePassword@2026'
      })
    });

    assert.equal(loginRes.status, 200);
    const loginData = await loginRes.json();
    assert.equal(loginData.success, true);
    assert.ok(loginData.token);
    assert.equal(loginData.user.phone, testPhone);

    // Bad password fails
    const badLogin = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userPhone: testPhone,
        userPassword: 'IncorrectPassword'
      })
    });
    assert.equal(badLogin.status, 200);
    const badData = await badLogin.json();
    assert.equal(badData.success, false);
  });

  // ── Test 4: Seeded Police Stations Query from PostgreSQL ──
  await t.test('GET /api/police-stations returns seeded police stations from PostgreSQL', async () => {
    const res = await fetch(`${baseUrl}/api/police-stations`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.count >= 28, `Expected at least 28 stations, got ${data.count}`);
    const station = data.stations[0];
    assert.ok(station.name);
    assert.ok(Array.isArray(station.phone), 'phone field must be an array');
  });

  // ── Test 5: Nearest Police Station calculation via PostgreSQL Haversine ──
  await t.test('GET /api/sos-nearest-station uses PostgreSQL spatial query', async () => {
    const res = await fetch(`${baseUrl}/api/sos-nearest-station?lat=21.1458&lng=79.0882`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.station);
    assert.ok(data.station.name);
    assert.ok(typeof data.station.distance === 'number');
    assert.ok(data.station.distance <= 50, 'Station should be within 50km');
  });

  // ── Test 6: Evidence Persistence with SHA-256 and PostgreSQL Metadata ──
  const trackingId = `trk_${Date.now()}`;

  await t.test('Evidence recording saves SHA-256 checksum and metadata to PostgreSQL', async () => {
    const payload = Buffer.from('TEST_AUDIO_EVIDENCE_STREAM_DATA_2026');
    const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');

    const result = await saveEvidence(trackingId, payload, 'webm', registeredUserId);
    assert.ok(result);
    assert.equal(result.sha256, expectedHash);
    createdEvidenceId = result.evidenceId;
    assert.ok(createdEvidenceId, 'createdEvidenceId must be returned');

    // Direct database query verification
    const dbRecord = await prisma.evidenceObject.findUnique({
      where: { id: createdEvidenceId }
    });
    assert.ok(dbRecord, 'Evidence record must exist in PostgreSQL evidence_objects table');
    assert.equal(dbRecord.trackingId, trackingId);
    assert.equal(dbRecord.sha256, expectedHash);
    assert.equal(dbRecord.sizeBytes, payload.length);
    assert.equal(dbRecord.userId, registeredUserId);

    // List evidence
    const list = await listEvidence(trackingId);
    assert.equal(list.length, 1);
    assert.equal(list[0].sha256, expectedHash);
  });

  // ── Test 7: Presigned URL requires authentication or authorization ──
  await t.test('Presigned URL authorization enforcement', async () => {
    // Unauthenticated request
    const unauthRes = await fetch(`${baseUrl}/api/evidence/presign/${createdEvidenceId}`);
    assert.equal(unauthRes.status, 401, 'Unauthenticated request must return HTTP 401');

    // Authenticated request with valid token
    const authRes = await fetch(`${baseUrl}/api/evidence/presign/${createdEvidenceId}`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    // In local dev without S3 credentials, 501 Not Implemented is expected
    assert.ok(authRes.status === 200 || authRes.status === 501);
  });

  // ── Test 8: Data persists across database restarts ──
  await t.test('PostgreSQL database persists records across stop and restart', async () => {
    await prisma.$disconnect();
    await pg.stop();

    // Restart the embedded postgres instance
    await pg.start();
    const health = await checkDatabaseHealth();
    assert.equal(health.ok, true, 'Database must recover and reconnect');

    // Verify the previously inserted user still exists
    const persistedUser = await prisma.user.findUnique({ where: { phone: testPhone } });
    assert.ok(persistedUser, 'User record must persist across PostgreSQL restarts');
    assert.equal(persistedUser.name, 'Priya Deshmukh');

    // Verify the previously inserted evidence still exists
    assert.ok(createdEvidenceId, 'createdEvidenceId should be populated');
    const persistedEvidence = await prisma.evidenceObject.findUnique({
      where: { id: createdEvidenceId }
    });
    assert.ok(persistedEvidence, 'Evidence record must persist across PostgreSQL restarts');
    assert.equal(persistedEvidence.trackingId, trackingId);
  });
});
