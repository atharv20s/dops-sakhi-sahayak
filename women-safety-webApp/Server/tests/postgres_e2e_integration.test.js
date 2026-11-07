const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

test('PostgreSQL End-to-End Integration, Security & Persistence Suite', async (t) => {
  let embeddedPg = null;

  // Use the single PostgreSQL instance if DATABASE_URL is already provided (e.g. CI runner)
  // Otherwise, start embedded-postgres locally and run migrations & seed
  if (!process.env.DATABASE_URL) {
    const EmbeddedPostgres = require('embedded-postgres').default;
    const PG_PORT = 5433;
    embeddedPg = new EmbeddedPostgres({ port: PG_PORT });
    await embeddedPg.start();
    process.env.DATABASE_URL = `postgresql://postgres:password@localhost:${PG_PORT}/postgres?schema=public`;

    execSync('npx prisma migrate deploy', { env: process.env, stdio: 'ignore' });
    execSync('node prisma/seed.js', { env: process.env, stdio: 'ignore' });
  }

  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'sakhi-test-secure-jwt-signing-key-32-chars-long!';
  process.env.S3_EVIDENCE_BUCKET = ''; // Local storage mode for integration test

  const { prisma, checkDatabaseHealth } = require('../db');
  const { app, server, io } = require('../index');
  const { saveEvidence, listEvidence } = require('../evidenceRecorder');
  const {
    getJwtSecret,
    generateToken,
    verifyToken,
    revokeToken,
    isTokenRevoked,
    constantTimeEquals
  } = require('../auth');

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
    if (embeddedPg) {
      await embeddedPg.stop();
    }
  });

  // ── Test 1: Readiness probe confirms single PostgreSQL instance is connected ──
  await t.test('GET /ready confirms PostgreSQL is connected with latency metric', async () => {
    const res = await fetch(`${baseUrl}/ready`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ready');
    assert.equal(data.database, 'connected');
    assert.ok(typeof data.latencyMs === 'number');
    assert.ok(data.latencyMs >= 0);
  });

  // ── Test 2: JWT Security, Constant-Time Comparison & Session Revocation ──
  await t.test('JWT Security & Session Revocation Lifecycle', async () => {
    // A. Constant-time equality check
    assert.equal(constantTimeEquals('secret-sig-1', 'secret-sig-1'), true);
    assert.equal(constantTimeEquals('secret-sig-1', 'secret-sig-2'), false);
    assert.equal(constantTimeEquals('short', 'much-longer-string'), false);

    // B. Token generation & verification
    const mockUser = { id: 'usr-12345', phone: '9999999999', name: 'Security Test' };
    const testToken = generateToken(mockUser);
    const decoded = verifyToken(testToken);
    assert.ok(decoded);
    assert.equal(decoded.phone, '9999999999');

    // C. Token revocation persists and invalidates session
    assert.equal(await isTokenRevoked(testToken), false);
    await revokeToken(testToken);
    assert.equal(await isTokenRevoked(testToken), true);
    assert.equal(verifyToken(testToken), null, 'Revoked token must fail verification');

    // D. In production, missing or short JWT_SECRET throws
    const originalEnv = process.env.NODE_ENV;
    const originalSecret = process.env.JWT_SECRET;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.JWT_SECRET;
      assert.throws(() => getJwtSecret(), /missing in production/);

      process.env.JWT_SECRET = 'too-short';
      assert.throws(() => getJwtSecret(), /at least 32 characters/);
    } finally {
      process.env.NODE_ENV = originalEnv;
      process.env.JWT_SECRET = originalSecret;
    }
  });

  // ── Test 3: User registration persists directly to PostgreSQL ──
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
    assert.ok(signupData.token, 'Must return JWT session token');
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

  // ── Test 4: User login validates bcrypt password against PostgreSQL ──
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

  // ── Test 5: Seeded Police Stations Query from PostgreSQL ──
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

  // ── Test 6: Nearest Police Station calculation via PostgreSQL Haversine ──
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

  // ── Test 7: Evidence Authorization Policy for Owned & Anonymous Evidence ──
  const ownedTrackingId = `trk_owned_${Date.now()}`;
  const anonTrackingId = `trk_anon_${Date.now()}`;
  let anonEvidenceId = null;
  let anonTrackingSecret = null;

  // A. Create owned evidence
  await t.test('Save owned evidence and verify user linkage in PostgreSQL', async () => {
    const payload = Buffer.from('AUDIO_PAYLOAD_OWNED_USER');
    const hash = crypto.createHash('sha256').update(payload).digest('hex');

    const result = await saveEvidence(ownedTrackingId, payload, 'webm', registeredUserId);
    assert.ok(result.evidenceId);
    createdEvidenceId = result.evidenceId;

    const dbRecord = await prisma.evidenceObject.findUnique({ where: { id: createdEvidenceId } });
    assert.equal(dbRecord.userId, registeredUserId);
    assert.equal(dbRecord.sha256, hash);
  });

  // B. Create anonymous emergency evidence
  await t.test('Save anonymous emergency evidence and generate trackingSecret', async () => {
    const payload = Buffer.from('AUDIO_PAYLOAD_ANONYMOUS_EMERGENCY');
    const result = await saveEvidence(anonTrackingId, payload, 'webm', null);
    assert.ok(result.evidenceId);
    assert.ok(result.trackingSecret, 'Anonymous evidence must return a trackingSecret');
    anonEvidenceId = result.evidenceId;
    anonTrackingSecret = result.trackingSecret;

    const dbRecord = await prisma.evidenceObject.findUnique({ where: { id: anonEvidenceId } });
    assert.equal(dbRecord.userId, null);
    assert.ok(dbRecord.metadata.trackingSecretHash);
  });

  // C. Test evidence authorization matrices
  await t.test('Enforce strict evidence access authorization policies', async () => {
    // Create a second registered user token
    const otherToken = generateToken({ id: 'usr-different-456', phone: '9988776655', name: 'Other User' });

    // 1. Owned evidence accessed by owner -> 200 or 501 (S3 storage)
    const ownerRes = await fetch(`${baseUrl}/api/evidence/presign/${createdEvidenceId}`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    assert.ok([200, 501].includes(ownerRes.status), 'Owner access should be allowed');

    // 2. Owned evidence accessed by a DIFFERENT authenticated user -> 403 Forbidden!
    const intruderRes = await fetch(`${baseUrl}/api/evidence/presign/${createdEvidenceId}`, {
      headers: { Authorization: `Bearer ${otherToken}` }
    });
    assert.equal(intruderRes.status, 403, 'Different user must receive HTTP 403 Forbidden');

    // 3. Owned evidence accessed unauthenticated -> 401 Unauthorized!
    const anonRes = await fetch(`${baseUrl}/api/evidence/presign/${createdEvidenceId}`);
    assert.equal(anonRes.status, 401, 'Unauthenticated request must receive HTTP 401');

    // 4. Anonymous evidence accessed WITHOUT valid secret by another user -> 403 Forbidden!
    const badAnonRes = await fetch(`${baseUrl}/api/evidence/presign/${anonEvidenceId}`, {
      headers: { Authorization: `Bearer ${otherToken}` }
    });
    assert.equal(badAnonRes.status, 403, 'Anonymous evidence without secret must receive HTTP 403 Forbidden');

    // 5. Anonymous evidence accessed WITH valid trackingSecret -> allowed (200 or 501)
    const validAnonRes = await fetch(`${baseUrl}/api/evidence/presign/${anonEvidenceId}`, {
      headers: { 'x-tracking-secret': anonTrackingSecret }
    });
    assert.ok([200, 501].includes(validAnonRes.status), 'Anonymous evidence with valid secret should be authorized');
  });

  // ── Test 8: Safety Reports Fail-Closed and Privacy Controls ──
  await t.test('Safety reports privacy and fail-closed persistence', async () => {
    const reportRes = await fetch(`${baseUrl}/api/safety-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'poor-lighting',
        locality: 'Civil Lines West',
        description: 'Street light broken near park entrance',
        lat: '21.1458',
        lng: '79.0882',
        shareExact: false
      })
    });

    assert.equal(reportRes.status, 201);
    const data = await reportRes.json();
    assert.equal(data.success, true);
    assert.equal(data.report.lat, null, 'Coordinates must be masked when shareExact=false');
    assert.equal(data.report.lng, null);

    // Verify it was persisted to PostgreSQL
    const dbReport = await prisma.safetyReport.findUnique({ where: { id: data.report.id } });
    assert.ok(dbReport, 'Report must be in PostgreSQL safety_reports table');
  });

  // ── Test 9: Data Persists across Connection Teardown and Reconnect ──
  await t.test('PostgreSQL database records persist durably across disconnect and reconnect', async () => {
    await prisma.$disconnect();

    if (embeddedPg) {
      await embeddedPg.stop();
      await embeddedPg.start();
    }

    const health = await checkDatabaseHealth();
    assert.equal(health.ok, true, 'Database must be reachable and healthy');

    // Verify user persisted
    const persistedUser = await prisma.user.findUnique({ where: { phone: testPhone } });
    assert.ok(persistedUser, 'User record must persist in PostgreSQL');
    assert.equal(persistedUser.name, 'Priya Deshmukh');

    // Verify evidence persisted
    const persistedEvidence = await prisma.evidenceObject.findUnique({
      where: { id: createdEvidenceId }
    });
    assert.ok(persistedEvidence, 'Evidence record must persist in PostgreSQL');
    assert.equal(persistedEvidence.trackingId, ownedTrackingId);
  });
});
