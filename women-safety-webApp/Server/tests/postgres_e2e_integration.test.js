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
  const { saveEvidence, listEvidence, createMetadata, EVIDENCE_DIR } = require('../evidenceRecorder');
  const {
    getJwtSecret,
    generateToken,
    verifyToken,
    revokeToken,
    isTokenRevoked,
    constantTimeEquals,
    clearInMemoryRevocationCache
  } = require('../auth');
  const ioClient = require('socket.io-client');

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

    // C. Token revocation persists in DB and survives in-memory cache clearing
    assert.equal(await isTokenRevoked(testToken), false);
    await revokeToken(testToken);
    assert.equal(await isTokenRevoked(testToken), true);

    // Clear in-memory cache to prove it queries PostgreSQL directly
    clearInMemoryRevocationCache();
    assert.equal(await isTokenRevoked(testToken), true, 'Must query PostgreSQL revoked_tokens table when cache cleared');

    // Verify record in PostgreSQL directly via Prisma
    const tokenHash = crypto.createHash('sha256').update(testToken).digest('hex');
    const dbRevoked = await prisma.revokedToken.findUnique({ where: { tokenHash } });
    assert.ok(dbRevoked, 'Revoked token row must exist in PostgreSQL');
    assert.equal(dbRevoked.tokenHash, tokenHash);
    assert.equal(verifyToken(testToken), null, 'Revoked token must fail verification');

    // D. Fail-closed on database revocation query error
    const originalFindUnique = prisma.revokedToken.findUnique;
    try {
      prisma.revokedToken.findUnique = async () => { throw new Error('Simulated DB network failure'); };
      clearInMemoryRevocationCache();
      await assert.rejects(
        async () => { await isTokenRevoked(testToken); },
        (err) => {
          assert.equal(err.statusCode, 503);
          assert.match(err.message, /Database unavailable/);
          return true;
        }
      );
    } finally {
      prisma.revokedToken.findUnique = originalFindUnique;
    }

    // E. JWT Key Rotation via JWT_SECRET_PREVIOUS
    const prevSecret = 'previous-valid-key-with-at-least-32-chars-length!';
    process.env.JWT_SECRET_PREVIOUS = prevSecret;
    try {
      const prevSignedToken = generateToken(mockUser, 7, prevSecret);
      const verifiedPrev = verifyToken(prevSignedToken);
      assert.ok(verifiedPrev, 'Token signed with previous key must be valid during rotation');
      assert.equal(verifiedPrev.phone, '9999999999');
    } finally {
      delete process.env.JWT_SECRET_PREVIOUS;
    }

    // F. In production, missing or short JWT_SECRET throws
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

  // ── Test 9: Logout Fail-Closed & Session Revocation Verification ──
  await t.test('POST /api/logout revokes session and fails closed if database write fails', async () => {
    // 1. Successful logout
    const logoutToken = generateToken({ id: registeredUserId, phone: testPhone, name: 'Priya Deshmukh' });
    const logoutRes = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${logoutToken}` }
    });
    assert.equal(logoutRes.status, 200);
    const logoutData = await logoutRes.json();
    assert.equal(logoutData.success, true);
    assert.equal(await isTokenRevoked(logoutToken), true);

    // 2. Database write failure triggers HTTP 503 fail-closed response
    const originalUpsert = prisma.revokedToken.upsert;
    try {
      prisma.revokedToken.upsert = async () => { throw new Error('Simulated DB outage during logout'); };
      const failToken = generateToken({ id: registeredUserId, phone: testPhone, name: 'Priya Deshmukh' });
      const failLogoutRes = await fetch(`${baseUrl}/api/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${failToken}` }
      });
      assert.equal(failLogoutRes.status, 503, 'Logout must fail closed with 503 when DB cannot persist revocation');
      const failData = await failLogoutRes.json();
      assert.equal(failData.success, false);
      assert.match(failData.error, /Failed to persist session revocation/);
    } finally {
      prisma.revokedToken.upsert = originalUpsert;
    }
  });

  // ── Test 10: Socket.IO Handshake Authentication & Fail-Closed Revocation ──
  await t.test('Socket.IO handshake authentication validates tokens and rejects revoked sessions', async () => {
    // 1. Anonymous connection succeeds (emergency SOS requirement)
    const anonSocket = ioClient(baseUrl, {
      transports: ['websocket'],
      forceNew: true
    });
    await new Promise((resolve, reject) => {
      anonSocket.on('connect', resolve);
      anonSocket.on('connect_error', reject);
    });
    assert.ok(anonSocket.connected);
    anonSocket.disconnect();

    // 2. Valid token connection succeeds
    const validSocketToken = generateToken({ id: 'usr-socket-ok', phone: '9123456789', name: 'Socket User' });
    const validSocket = ioClient(baseUrl, {
      auth: { token: validSocketToken },
      transports: ['websocket'],
      forceNew: true
    });
    await new Promise((resolve, reject) => {
      validSocket.on('connect', resolve);
      validSocket.on('connect_error', reject);
    });
    assert.ok(validSocket.connected);
    validSocket.disconnect();

    // 3. Revoked token is rejected during handshake
    const toRevokeToken = generateToken({ id: 'usr-socket-revoked', phone: '9988112233', name: 'Revoked User' });
    await revokeToken(toRevokeToken);

    const revokedSocket = ioClient(baseUrl, {
      auth: { token: toRevokeToken },
      transports: ['websocket'],
      forceNew: true
    });
    const err = await new Promise((resolve) => {
      revokedSocket.on('connect', () => resolve(null));
      revokedSocket.on('connect_error', (e) => resolve(e));
    });
    assert.ok(err, 'Revoked token handshake must fail');
    assert.match(err.message, /Token has been revoked/);
    revokedSocket.disconnect();

    // 4. Invalid token is rejected
    const badSocket = ioClient(baseUrl, {
      auth: { token: 'invalid.corrupted.jwt' },
      transports: ['websocket'],
      forceNew: true
    });
    const badErr = await new Promise((resolve) => {
      badSocket.on('connect', () => resolve(null));
      badSocket.on('connect_error', (e) => resolve(e));
    });
    assert.ok(badErr, 'Corrupt token handshake must fail');
    assert.match(badErr.message, /Invalid or expired token/);
    badSocket.disconnect();
  });

  // ── Test 11: Per-record authorization in listEvidence prevents cross-tenant leakage ──
  await t.test('listEvidence enforces strict per-record authorization on shared trackingId', async () => {
    const sharedTrackingId = `trk_shared_${Date.now()}`;
    const userA = registeredUserId;
    const userBRecord = await prisma.user.create({
      data: {
        name: 'Tenant Bravo',
        phone: `9876${Date.now().toString().slice(-6)}`,
        passwordHash: '$2a$10$abcdefghijklmnopqrstuv'
      }
    });
    const userB = userBRecord.id;
    const unrelatedUserId = crypto.randomUUID();

    // User A saves evidence under sharedTrackingId
    const resA = await saveEvidence(sharedTrackingId, Buffer.from('AUDIO_USER_A'), 'webm', userA);
    assert.ok(resA.evidenceId);

    // User B saves evidence under same sharedTrackingId
    const resB = await saveEvidence(sharedTrackingId, Buffer.from('AUDIO_USER_B'), 'webm', userB);
    assert.ok(resB.evidenceId);

    // When User A queries evidence for sharedTrackingId, they MUST ONLY see their own record
    const listA = await listEvidence(sharedTrackingId, userA);
    assert.equal(listA.length, 1);
    assert.equal(listA[0].id, resA.evidenceId);
    assert.equal(listA[0].userId, userA);

    // When User B queries evidence for sharedTrackingId, they MUST ONLY see their own record
    const listB = await listEvidence(sharedTrackingId, userB);
    assert.equal(listB.length, 1);
    assert.equal(listB[0].id, resB.evidenceId);
    assert.equal(listB[0].userId, userB);

    // When an unauthenticated user or unrelated user queries without authorization, it throws 403
    await assert.rejects(
      async () => { await listEvidence(sharedTrackingId, unrelatedUserId); },
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.match(err.message, /Forbidden/);
        return true;
      }
    );
  });

  // ── Test 12: Zero local disk writes and fail-closed storage in production ──
  await t.test('Zero local disk writes enforced in production environment', async () => {
    const origEnv = process.env.NODE_ENV;
    const origBucket = process.env.S3_EVIDENCE_BUCKET;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.S3_EVIDENCE_BUCKET;

      // 1. saveEvidence without S3 in production MUST fail-closed without writing to disk
      await assert.rejects(
        async () => { await saveEvidence('trk_prod_test', Buffer.from('TEST'), 'webm'); },
        /S3_EVIDENCE_BUCKET is required in production/
      );

      // 2. createMetadata without S3 in production MUST fail-closed without writing to disk
      await assert.rejects(
        async () => { await createMetadata('trk_prod_test', { status: 'test' }); },
        /S3_EVIDENCE_BUCKET is required in production/
      );
    } finally {
      process.env.NODE_ENV = origEnv;
      process.env.S3_EVIDENCE_BUCKET = origBucket;
    }
  });

  // ── Test 13: Data Persists across Connection Teardown and Reconnect ──
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
