const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { app, server, io } = require('../index');

let baseUrl;

test('PostgreSQL migration & security verification suite', async (t) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    io.close();
  });

  // ── 1. Readiness Probe ──
  await t.test('GET /ready and GET /api/ready return readiness status', async () => {
    for (const path of ['/ready', '/api/ready']) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'ready');
      assert.equal(data.service, 'sakhi-backend');
      assert.ok(data.timestamp);
    }
  });

  // ── 2. Password Hashing & Response Sanitization ──
  await t.test('Signup hashes password with bcrypt and never leaks password or hash', async () => {
    const testPhone = `999000${Date.now().toString().slice(-4)}`;
    const plainPassword = 'SuperSecretPassword123!';

    const res = await fetch(`${baseUrl}/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName: 'Aanya Sharma',
        userPhone: testPhone,
        userPassword: plainPassword,
        emergencyName: 'Raj Sharma',
        emergencyPhone: '9876543210'
      })
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.user);

    // CRITICAL SECURITY CHECKS:
    assert.equal(data.user.name, 'Aanya Sharma');
    assert.equal(data.user.phone, testPhone);
    assert.equal(data.user.password, undefined, 'Plaintext password must never be in API response');
    assert.equal(data.user.passwordHash, undefined, 'Password hash must never be in API response');
    assert.equal(data.user.password_hash, undefined, 'password_hash must never be in API response');

    // Test duplicate phone rejection
    const dupRes = await fetch(`${baseUrl}/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName: 'Duplicate User',
        userPhone: testPhone,
        userPassword: 'AnotherPassword',
        emergencyName: 'None',
        emergencyPhone: '0000000000'
      })
    });
    assert.equal(dupRes.status, 400);
    const dupData = await dupRes.json();
    assert.equal(dupData.success, false);

    // Test Login with correct password
    const loginRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userPhone: testPhone,
        userPassword: plainPassword
      })
    });
    assert.equal(loginRes.status, 200);
    const loginData = await loginRes.json();
    assert.equal(loginData.success, true);
    assert.equal(loginData.user.phone, testPhone);
    assert.equal(loginData.user.password, undefined);
    assert.equal(loginData.user.passwordHash, undefined);

    // Test Login with wrong password
    const badLoginRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userPhone: testPhone,
        userPassword: 'WrongPassword!'
      })
    });
    assert.equal(badLoginRes.status, 200);
    const badLoginData = await badLoginRes.json();
    assert.equal(badLoginData.success, false);
    assert.equal(badLoginData.msg, 'Invalid password!');
  });

  // ── 3. Safety Report Privacy Enforcement ──
  await t.test('Safety report privacy: shareExact=false masks coordinates to null', async () => {
    // A: Without consent (shareExact = false)
    const privateRes = await fetch(`${baseUrl}/api/safety-reports`, {
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
    assert.equal(privateRes.status, 201);
    const privateData = await privateRes.json();
    assert.equal(privateData.success, true);
    assert.equal(privateData.report.lat, null, 'lat must be null when shareExact is false');
    assert.equal(privateData.report.lng, null, 'lng must be null when shareExact is false');

    // B: With explicit consent (shareExact = true)
    const consentRes = await fetch(`${baseUrl}/api/safety-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'broken-cctv',
        locality: 'Dharampeth Square',
        description: 'Traffic camera is offline',
        lat: '21.1420',
        lng: '79.0680',
        shareExact: true
      })
    });
    assert.equal(consentRes.status, 201);
    const consentData = await consentRes.json();
    assert.equal(consentData.success, true);
    assert.equal(consentData.report.lat, 21.142);
    assert.equal(consentData.report.lng, 79.068);
  });

  // ── 4. Police Station & Nearest Station Queries ──
  await t.test('GET /api/nearest and /api/sos-nearest-station return nearest station', async () => {
    const res = await fetch(`${baseUrl}/api/nearest?lat=21.1458&lng=79.0882`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.police_station, 'police_station must be returned');
    assert.ok(typeof data.police_station.name === 'string');
    assert.ok(typeof data.police_station.distance === 'number');

    const sosRes = await fetch(`${baseUrl}/api/sos-nearest-station?lat=21.1458&lng=79.0882`);
    assert.equal(sosRes.status, 200);
    const sosData = await sosRes.json();
    assert.equal(sosData.success, true);
    assert.ok(sosData.station);
    assert.ok(Array.isArray(sosData.station.phone), 'phone must be an array');
    assert.ok(sosData.station.distanceText);
  });
});
