require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// ── Database Client (Prisma PostgreSQL) ──
const { prisma, checkDatabaseHealth, isDatabaseConfigured } = require('./db');

// ── Authentication & Rate Limiting ──
const {
  getJwtSecret,
  generateToken,
  verifyToken,
  revokeToken,
  isTokenRevoked,
  requireAuth,
  optionalAuth,
  createRateLimiter,
  constantTimeEquals
} = require('./auth');

// Fail fast on startup in production if JWT_SECRET is missing or insufficiently strong
getJwtSecret();

// ── LangGraph/Voice Agent Modules ──
const voiceAgent = require('./voiceAgent');
const { setupWebRTCSignaling } = require('./webrtcSignaling');
const { saveEvidence, listEvidence, getEvidenceDownloadUrl, EVIDENCE_DIR } = require('./evidenceRecorder');
const { dispatchFullEmergency, dispatchLiveLocation, EMERGENCY_EMAIL, EMERGENCY_PHONE } = require('./emergencyDispatcher');

const app = express();
const server = http.createServer(app);

// Cross-Origin configuration with production restrictions
const allowedOrigins = process.env.NODE_ENV === 'production' && process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(s => s.trim())
  : '*';

const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 10 * 1024 * 1024 // 10MB for audio uploads
});

// Socket.IO authentication middleware: populates verified user session from handshake
// FAILS CLOSED: Asynchronously verifies token validity and database revocation.
// Preserves anonymous access for emergency SOS when no token is provided.
io.use(async (socket, next) => {
  const token = socket.handshake?.auth?.token;
  if (!token) {
    // Preserve anonymous emergency connections
    return next();
  }

  // Verify structure, signature, and expiration
  const user = verifyToken(token, { ignoreRevocation: true });
  if (!user) {
    return next(new Error('Authentication failed: Invalid or expired token'));
  }

  try {
    const revoked = await isTokenRevoked(token);
    if (revoked) {
      return next(new Error('Authentication failed: Token has been revoked'));
    }
    socket.user = user;
    return next();
  } catch (err) {
    console.error('❌ [Socket.IO Auth] Handshake revocation check failed:', err.message);
    if (process.env.NODE_ENV === 'production' || isDatabaseConfigured()) {
      return next(new Error('Authentication service unavailable'));
    }
    socket.user = user;
    return next();
  }
});

// Setup Redis Adapter for multi-server WebSocket scaling if REDIS_URL is provided
if (process.env.REDIS_URL) {
  const { createAdapter } = require('@socket.io/redis-adapter');
  const { createClient } = require('redis');
  const pubClient = createClient({ url: process.env.REDIS_URL });
  const subClient = pubClient.duplicate();

  pubClient.on('error', (err) => console.error('[Redis Pub Error]', err.message));
  subClient.on('error', (err) => console.error('[Redis Sub Error]', err.message));

  Promise.all([pubClient.connect(), subClient.connect()])
    .then(() => {
      io.adapter(createAdapter(pubClient, subClient));
      console.log('⚡ Socket.IO Redis Cluster Adapter connected successfully (Multi-node Ready)');
    })
    .catch((err) => {
      console.warn('⚠️ Redis adapter failed to connect, falling back to standalone socket memory:', err.message);
    });
}

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '10mb' }));

// Lightweight health check — process liveness
const healthHandler = (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'sakhi-backend',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
};

// Dependency readiness check — verifies PostgreSQL connectivity (fail-closed)
const readyHandler = async (req, res) => {
  const dbHealth = await checkDatabaseHealth();
  if (dbHealth.ok) {
    return res.status(200).json({
      status: 'ready',
      service: 'sakhi-backend',
      database: 'connected',
      latencyMs: dbHealth.latencyMs,
      timestamp: new Date().toISOString()
    });
  }

  return res.status(503).json({
    status: 'unready',
    service: 'sakhi-backend',
    database: 'disconnected',
    error: dbHealth.error || 'PostgreSQL database connection required',
    timestamp: new Date().toISOString()
  });
};

// Direct health and readiness endpoints for Docker and infrastructure monitoring.
app.get('/health', healthHandler);
app.get('/ready', readyHandler);

// Serve evidence files statically
app.use('/evidence', express.static(EVIDENCE_DIR));

// Multer config for audio/evidence upload (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

const memoryUsers = []; // Fallback memory database (development only)

// ── Haversine distance formula ──
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ── Nearest Police Station Helper (PostgreSQL with Haversine fallback) ──
async function findNearestPoliceStation(userLat, userLng) {
  if (isDatabaseConfigured()) {
    try {
      const stations = await prisma.$queryRaw`
        SELECT id, name, lat, lng, phone, email, zone, officer_in_charge, type, category, address, description,
          (6371 * acos(
            cos(radians(${userLat})) * cos(radians(lat)) *
            cos(radians(lng) - radians(${userLng})) +
            sin(radians(${userLat})) * sin(radians(lat))
          )) AS distance_km
        FROM police_stations
        WHERE category = 'station'
          AND lat BETWEEN (${userLat} - 0.5) AND (${userLat} + 0.5)
          AND lng BETWEEN (${userLng} - 0.5) AND (${userLng} + 0.5)
        ORDER BY distance_km ASC
        LIMIT 1
      `;
      if (stations && stations.length > 0) {
        const s = stations[0];
        const distance = Number(s.distance_km);
        if (distance <= 50) {
          const phoneList = Array.isArray(s.phone) ? s.phone : (s.phone ? [s.phone] : []);
          return {
            source: 'postgresql',
            station: {
              name: s.name,
              phone: phoneList,
              email: s.email,
              zone: s.zone,
              officerInCharge: s.officer_in_charge,
              type: s.type,
              lat: s.lat,
              lng: s.lng,
              address: s.address,
              description: s.description,
              distance,
              distanceText: distance > 1 ? `${distance.toFixed(1)} km` : `${(distance * 1000).toFixed(0)} m`
            }
          };
        }
      }
    } catch (dbErr) {
      console.warn('⚠️ PostgreSQL station query error, falling back:', dbErr.message);
    }
  }

  // Fallback to safety_data.json
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'safety_data.json'), 'utf8'));
    const stations = data.police_stations || [];
    let nearest = null;
    let minDist = Infinity;
    stations.forEach(st => {
      const d = haversineDistance(userLat, userLng, st.lat, st.lng);
      if (d < minDist) {
        minDist = d;
        nearest = { ...st, distance: d };
      }
    });
    if (nearest) {
      return {
        source: 'json_fallback',
        station: {
          name: nearest.name,
          phone: nearest.contact ? [nearest.contact] : [],
          email: nearest.email || '',
          zone: '',
          officerInCharge: '',
          type: 'city',
          lat: nearest.lat,
          lng: nearest.lng,
          address: '',
          description: nearest.description || '',
          distance: nearest.distance,
          distanceText: nearest.distance > 1 ? `${nearest.distance.toFixed(1)} km` : `${(nearest.distance * 1000).toFixed(0)} m`
        }
      };
    }
  } catch (err) {
    console.error('Station fallback error:', err);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════
const router = express.Router();

// Rate limiter for authentication routes (max 25 requests per 15 mins per IP)
const authLimiter = createRateLimiter(25, 15 * 60 * 1000);

// ── Auth: Signup (bcryptjs work factor 12, secure token session, zero plaintext leakage) ──
router.post('/signup', authLimiter, async (req, res) => {
  try {
    const { userName, userPhone, userPassword, emergencyName, emergencyPhone } = req.body || {};
    if (!userName || !userPhone || !userPassword) {
      return res.status(400).json({ success: false, msg: 'Name, phone and password are required.' });
    }

    if (isDatabaseConfigured()) {
      const existingUser = await prisma.user.findUnique({ where: { phone: String(userPhone) } });
      if (existingUser) {
        return res.status(400).json({ success: false, msg: 'User with this phone number already exists! Please login.' });
      }

      const passwordHash = await bcrypt.hash(String(userPassword), 12);
      const newUser = await prisma.user.create({
        data: {
          name: String(userName),
          phone: String(userPhone),
          passwordHash,
          emergencyContactName: emergencyName || null,
          emergencyContactPhone: emergencyPhone || null
        }
      });

      const token = generateToken(newUser);

      return res.status(201).json({
        success: true,
        token,
        user: {
          name: newUser.name,
          phone: newUser.phone,
          emergencyContact: {
            name: newUser.emergencyContactName,
            phone: newUser.emergencyContactPhone
          }
        },
        msg: 'Signup successful!'
      });
    }

    // In production, do not silently downgrade to memory
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ success: false, msg: 'Database unavailable. In-memory storage is disabled in production.' });
    }

    // Local development fallback with bcrypt
    if (memoryUsers.find(u => u.phone === userPhone)) {
      return res.status(400).json({ success: false, msg: 'User already exists! Please login.' });
    }

    const passwordHash = await bcrypt.hash(String(userPassword), 12);
    const memUser = {
      id: `mem-${Date.now()}`,
      name: userName,
      phone: userPhone,
      passwordHash,
      emergencyContact: { name: emergencyName, phone: emergencyPhone }
    };
    memoryUsers.push(memUser);

    const token = generateToken(memUser);

    return res.status(201).json({
      success: true,
      token,
      user: {
        name: memUser.name,
        phone: memUser.phone,
        emergencyContact: memUser.emergencyContact
      },
      msg: 'Signup successful (Memory Dev Mode)'
    });
  } catch (err) {
    console.error('Signup Route Error: ', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Auth: Login (bcryptjs compare, secure token session, zero password leakage) ──
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { userPhone, userPassword } = req.body || {};
    if (!userPhone || !userPassword) {
      return res.status(400).json({ success: false, msg: 'Phone and password are required.' });
    }

    if (isDatabaseConfigured()) {
      const user = await prisma.user.findUnique({ where: { phone: String(userPhone) } });
      if (!user) {
        return res.status(200).json({ success: false, msg: 'User not found!' });
      }

      const isMatch = await bcrypt.compare(String(userPassword), user.passwordHash);
      if (!isMatch) {
        return res.status(200).json({ success: false, msg: 'Invalid password!' });
      }

      const token = generateToken(user);

      return res.status(200).json({
        success: true,
        token,
        user: {
          name: user.name,
          phone: user.phone,
          emergencyContact: {
            name: user.emergencyContactName,
            phone: user.emergencyContactPhone
          }
        },
        msg: 'Login successful!'
      });
    }

    // In production, do not silently downgrade to memory
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ success: false, msg: 'Database unavailable. In-memory storage is disabled in production.' });
    }

    // Local development fallback
    const memUser = memoryUsers.find(u => u.phone === userPhone);
    if (!memUser) return res.status(200).json({ success: false, msg: 'User not found! (Memory Mode)' });
    const match = memUser.passwordHash
      ? await bcrypt.compare(String(userPassword), memUser.passwordHash)
      : (memUser.password === userPassword);
    if (!match) return res.status(200).json({ success: false, msg: 'Invalid password!' });

    const token = generateToken(memUser);

    return res.status(200).json({
      success: true,
      token,
      user: {
        name: memUser.name,
        phone: memUser.phone,
        emergencyContact: memUser.emergencyContact
      },
      msg: 'Login successful!'
    });
  } catch (err) {
    console.error('Login Route Error: ', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Auth: Logout / Session Revocation (persists revoked token hash) ──
// FAILS CLOSED: Returns 503 if database cannot persist the revocation
router.post('/logout', requireAuth, async (req, res) => {
  try {
    if (req.token) {
      await revokeToken(req.token);
    }
    res.json({ success: true, msg: 'Session successfully revoked. Logged out.' });
  } catch (err) {
    console.error('❌ [Auth] Logout error:', err.message);
    res.status(err.statusCode || 503).json({ success: false, error: err.message });
  }
});

// ── Safety Data ──
router.get('/danger-zones', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'safety_data.json'), 'utf8'));
    res.json(data.danger_zones || []);
  } catch (err) {
    res.json([]);
  }
});

router.get('/safety-data', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'safety_data.json'), 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load safety data' });
  }
});

router.get('/nearest', async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);

    // 1. Police station (PostgreSQL via findNearestPoliceStation)
    const nearestPoliceResult = await findNearestPoliceStation(userLat, userLng);
    let policeStationObj = null;
    if (nearestPoliceResult && nearestPoliceResult.station) {
      const st = nearestPoliceResult.station;
      policeStationObj = {
        name: st.name,
        distance: st.distance,
        description: st.description,
        contact: Array.isArray(st.phone) && st.phone.length > 0 ? st.phone[0] : (st.phone || '')
      };
    }

    // 2. Hospital, Metro, Danger Zone from safety_data.json
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'safety_data.json'), 'utf8'));

    const findNearest = (list) => {
      if (!list || list.length === 0) return null;
      let nearest = null;
      let minDistance = Infinity;
      list.forEach(item => {
        const itemLat = item.lat !== undefined ? item.lat : (item.center ? item.center[0] : null);
        const itemLng = item.lng !== undefined ? item.lng : (item.center ? item.center[1] : null);
        if (itemLat !== null && itemLng !== null) {
          const d = haversineDistance(userLat, userLng, itemLat, itemLng);
          if (d < minDistance) { minDistance = d; nearest = { ...item, distance: d }; }
        }
      });
      return nearest;
    };

    res.json({
      police_station: policeStationObj || findNearest(data.police_stations),
      hospital: findNearest(data.hospitals),
      metro: findNearest(data.metro_stations),
      danger_zone: findNearest(data.danger_zones)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SOS Nearest Station ──
router.get('/sos-nearest-station', async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ success: false, error: 'Missing lat/lng coordinates' });

    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);

    const result = await findNearestPoliceStation(userLat, userLng);
    if (result && result.station) {
      return res.json({
        success: true,
        source: result.source,
        station: result.station,
        userLocation: {
          lat: userLat,
          lng: userLng,
          googleMapsLink: `https://maps.google.com/maps?q=${userLat},${userLng}`,
          timestamp: new Date().toISOString()
        }
      });
    }

    res.status(404).json({ success: false, error: 'No police stations found nearby' });
  } catch (err) {
    console.error('SOS Nearest Station Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Get All Police Stations ──
router.get('/police-stations', async (req, res) => {
  try {
    if (isDatabaseConfigured()) {
      try {
        const stations = await prisma.policeStation.findMany({
          where: { category: 'station' },
          orderBy: { name: 'asc' }
        });
        if (stations && stations.length > 0) {
          return res.json({ success: true, count: stations.length, stations });
        }
      } catch (dbErr) {
        console.warn('⚠️ PostgreSQL police stations query error, using fallback:', dbErr.message);
      }
    }

    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'safety_data.json'), 'utf8'));
    res.json({ success: true, count: (data.police_stations || []).length, stations: data.police_stations || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  SARVAM AI STT — Transcription Proxy
//  Supports Hindi (hi-IN), Marathi (mr-IN), English (en-IN) ONLY
// ═══════════════════════════════════════════════════════════════
router.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No audio file provided' });
    }

    console.log(`[Transcribe] Received audio: ${req.file.size} bytes, type: ${req.file.mimetype}`);

    // Build native web FormData for Sarvam AI (Node 18+)
    const audioBlob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' });
    const formData = new FormData();
    formData.append('file', audioBlob, req.file.originalname || 'audio.webm');
    formData.append('model', 'saaras:v3');
    formData.append('mode', 'transcribe');
    // Hint Sarvam to detect Hindi, Marathi, and English
    formData.append('language_code', 'unknown');

    let transcript = '';
    let language = 'unknown';
    let rawData = null;

    try {
      const sarvamResp = await fetch('https://api.sarvam.ai/speech-to-text', {
        method: 'POST',
        headers: { 'api-subscription-key': process.env.SARVAM_API_KEY },
        body: formData
      });

      if (!sarvamResp.ok) {
        const errorText = await sarvamResp.text();
        throw new Error(`Sarvam API status ${sarvamResp.status}: ${errorText}`);
      }
      
      rawData = await sarvamResp.json();
      transcript = rawData.transcript || '';
      language = rawData.language_code || 'unknown';
      console.log(`[Transcribe] Sarvam success:`, transcript.substring(0, 50));

    } catch (apiErr) {
      console.log(`[Transcribe] ⚠️ Sarvam AI failed (${apiErr.message}). Falling back to Local Python Whisper on port 8000...`);
      
      try {
        const localFormData = new FormData();
        const localBlob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' });
        localFormData.append('audio', localBlob, 'audio.webm');

        const localResp = await fetch('http://localhost:8000/api/transcribe', {
          method: 'POST',
          body: localFormData
        });

        if (!localResp.ok) throw new Error(`Local Python Whisper failed with status ${localResp.status}`);
        
        rawData = await localResp.json();
        transcript = rawData.transcript || '';
        language = rawData.language || 'unknown';
        console.log(`[Transcribe] Local Whisper success:`, transcript.substring(0, 50));
      } catch (localErr) {
        console.log(`[Transcribe] ⚠️ Local Whisper failed (${localErr.message}). Both STT engines failed.`);
        return res.status(200).json({
          success: false,
          error: "Transcription unavailable. Neither Sarvam AI nor local Whisper responded.",
          transcript: "Emergency Help Needed! (Transcription failed)",
          language: "unknown",
          isSupported: true // forces it to proceed
        });
      }
    }

    // Only accept Hindi, Marathi, English
    const SUPPORTED_LANGS = ['hi-IN', 'mr-IN', 'en-IN', 'hi', 'mr', 'en'];
    const isSupported = SUPPORTED_LANGS.some(l => language.startsWith(l.split('-')[0]));

    res.json({
      success: true,
      transcript,
      language,
      isSupported,
      raw: rawData
    });

  } catch (err) {
    console.error('[Transcribe] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Evidence Upload ──
router.post('/upload-evidence', optionalAuth, upload.single('evidence'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No evidence file provided'
      });
    }

    const { trackingId, trackingSecret, format } = req.body || {};

    if (
      typeof trackingId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(trackingId)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid tracking ID'
      });
    }

    // Authenticated user identity comes strictly from verified session
    const verifiedUserId = req.user ? req.user.userId : null;
    const result = await saveEvidence(
      trackingId,
      req.file.buffer,
      format || 'webm',
      verifiedUserId,
      trackingSecret || null
    );

    return res.json({ success: true, ...result });

  } catch (err) {
    console.error('[Evidence Upload] Error:', err.message);

    return res.status(err.statusCode || 500).json({
      success: false,
      error: err.message
    });
  }
});

// ── Evidence Listing ──
router.get('/evidence/:trackingId', optionalAuth, async (req, res) => {
  try {
    const requestingUserId = req.user ? req.user.userId : null;
    const trackingSecret = req.headers['x-tracking-secret'] || req.query.secret || null;
    const files = await listEvidence(req.params.trackingId, requestingUserId, trackingSecret);
    res.json({ success: true, trackingId: req.params.trackingId, count: files.length, files });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

const SERVICES_FILE = path.join(__dirname, 'trusted_services.json');
const REPORTS_FILE = path.join(__dirname, 'safety_reports.json');

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function coarseCoord(value) {
  return Math.round(Number(value) * 100) / 100;
}

router.get('/trusted-services', (req, res) => {
  try {
    const data = readJsonFile(SERVICES_FILE, { services: [] });
    const { audience, category, q, anonymous, open24 } = req.query;
    let services = data.services || [];

    if (audience) {
      services = services.filter(s => (s.audience || []).includes(audience));
    }
    if (category) {
      services = services.filter(s => s.category === category);
    }
    if (anonymous === 'true') {
      services = services.filter(s => s.anonymousOk);
    }
    if (open24 === 'true') {
      services = services.filter(s => String(s.hours || '').includes('24'));
    }
    if (q) {
      const needle = String(q).toLowerCase();
      services = services.filter(s =>
        [s.name, s.whatTheyDo, s.city, s.category, ...(s.languages || [])]
          .join(' ')
          .toLowerCase()
          .includes(needle)
      );
    }

    res.json({ success: true, count: services.length, services });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Evidence Download URL (Authorized Presigned S3 URL) ──
router.get('/evidence/:trackingId/:fileName/url', optionalAuth, async (req, res) => {
  try {
    const { trackingId, fileName } = req.params;
    const requestingUserId = req.user?.userId || null;
    const trackingSecret = req.headers['x-tracking-secret'] || req.query.secret || null;

    if (!isDatabaseConfigured()) {
      return res.status(501).json({ success: false, error: 'Database unconfigured for evidence metadata.' });
    }

    const record = await prisma.evidenceObject.findFirst({
      where: { trackingId, fileName }
    });

    if (!record) {
      return res.status(404).json({ success: false, error: 'Evidence record not found.' });
    }

    // Strict Authorization Check:
    if (record.userId) {
      if (!requestingUserId) {
        return res.status(401).json({ success: false, error: 'Authentication required to access this evidence.' });
      }
      if (record.userId !== requestingUserId) {
        return res.status(403).json({ success: false, error: 'Forbidden: You do not have permission to access this evidence.' });
      }
    } else {
      const expectedHash = record.metadata?.trackingSecretHash;
      if (expectedHash) {
        const providedHash = trackingSecret ? crypto.createHash('sha256').update(trackingSecret).digest('hex') : null;
        if (!providedHash || !constantTimeEquals(providedHash, expectedHash)) {
          return res.status(403).json({ success: false, error: 'Forbidden: Valid emergency tracking secret required for anonymous evidence.' });
        }
      }
    }

    const result = await getEvidenceDownloadUrl(trackingId, fileName, requestingUserId, trackingSecret);
    if (!result) {
      return res.status(501).json({ success: false, error: 'S3 presigned URL not available. Ensure S3_EVIDENCE_BUCKET is configured.' });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ── Evidence Presigned S3 URL by Evidence ID (Protected) ──
router.get('/evidence/presign/:evidenceId', optionalAuth, async (req, res) => {
  try {
    const { evidenceId } = req.params;
    const requestingUserId = req.user?.userId || null;
    const trackingSecret = req.headers['x-tracking-secret'] || req.query.secret || null;

    if (!isDatabaseConfigured()) {
      return res.status(501).json({ success: false, error: 'Database unconfigured for evidence metadata.' });
    }

    const record = await prisma.evidenceObject.findUnique({
      where: { id: evidenceId }
    });

    if (!record) {
      return res.status(404).json({ success: false, error: 'Evidence record not found.' });
    }

    // Strict Authorization Check:
    if (record.userId) {
      if (!requestingUserId) {
        return res.status(401).json({ success: false, error: 'Authentication required to access this evidence.' });
      }
      if (record.userId !== requestingUserId) {
        return res.status(403).json({ success: false, error: 'Forbidden: You do not have permission to access this evidence.' });
      }
    } else {
      const expectedHash = record.metadata?.trackingSecretHash;
      if (expectedHash) {
        const providedHash = trackingSecret ? crypto.createHash('sha256').update(trackingSecret).digest('hex') : null;
        if (!providedHash || !constantTimeEquals(providedHash, expectedHash)) {
          return res.status(403).json({ success: false, error: 'Forbidden: Valid emergency tracking secret required for anonymous evidence.' });
        }
      }
    }

    const result = await getEvidenceDownloadUrl(record.trackingId, record.fileName, requestingUserId, trackingSecret);
    if (!result) {
      return res.status(501).json({ success: false, error: 'S3 storage is not configured for presigned download.' });
    }

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

router.get('/safety-reports', async (req, res) => {
  try {
    if (isDatabaseConfigured()) {
      try {
        const dbReports = await prisma.safetyReport.findMany({
          orderBy: { createdAt: 'desc' }
        });
        const reports = dbReports.map(r => ({
          id: r.id,
          category: r.category,
          locality: r.locality,
          description: r.description,
          lat: r.shareExact ? r.lat : null,
          lng: r.shareExact ? r.lng : null,
          createdAt: r.createdAt
        }));
        return res.json({ success: true, count: reports.length, reports });
      } catch (dbErr) {
        console.error('❌ PostgreSQL safety reports query error:', dbErr.message);
        return res.status(503).json({
          success: false,
          error: 'Database unavailable. Dynamic safety reports cannot be loaded.'
        });
      }
    }

    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({
        success: false,
        error: 'Database connection required in production to read safety reports.'
      });
    }

    const data = readJsonFile(REPORTS_FILE, { reports: [] });
    const reports = (data.reports || []).map(r => ({
      id: r.id,
      category: r.category,
      locality: r.locality,
      description: r.description,
      lat: r.exact ? r.lat : null,
      lng: r.exact ? r.lng : null,
      createdAt: r.createdAt
    }));
    res.json({ success: true, count: reports.length, reports });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/safety-reports', async (req, res) => {
  try {
    const { category, locality, description, lat, lng, shareExact } = req.body || {};
    if (!category || !description) {
      return res.status(400).json({ success: false, msg: 'Category and description are required.' });
    }

    const parsedLat = lat !== undefined && lat !== '' ? parseFloat(lat) : null;
    const parsedLng = lng !== undefined && lng !== '' ? parseFloat(lng) : null;
    const exact = Boolean(shareExact) && parsedLat !== null && parsedLng !== null;

    // Strict privacy consent: When shareExact is false, lat/lng MUST be null
    const storedLat = exact ? parsedLat : null;
    const storedLng = exact ? parsedLng : null;

    if (isDatabaseConfigured()) {
      try {
        const report = await prisma.safetyReport.create({
          data: {
            category: String(category).slice(0, 50),
            locality: String(locality || 'Area withheld').slice(0, 150),
            description: String(description).slice(0, 800),
            lat: storedLat,
            lng: storedLng,
            shareExact: exact
          }
        });

        return res.status(201).json({
          success: true,
          msg: 'Report saved. No name or phone was stored.',
          report: {
            id: report.id,
            category: report.category,
            locality: report.locality,
            description: report.description,
            lat: report.lat,
            lng: report.lng,
            createdAt: report.createdAt
          }
        });
      } catch (dbErr) {
        console.error('❌ PostgreSQL safety report creation error:', dbErr.message);
        return res.status(503).json({
          success: false,
          error: 'Database write failed. Report could not be recorded.'
        });
      }
    }

    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({
        success: false,
        error: 'Database connection required in production. Local file persistence is disabled.'
      });
    }

    const report = {
      id: `r-${Date.now()}`,
      category: String(category).slice(0, 80),
      locality: String(locality || 'Area withheld').slice(0, 120),
      description: String(description).slice(0, 800),
      lat: storedLat,
      lng: storedLng,
      exact,
      createdAt: new Date().toISOString()
    };

    const data = readJsonFile(REPORTS_FILE, { reports: [] });
    data.reports = data.reports || [];
    data.reports.unshift(report);
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(data, null, 2));

    res.status(201).json({
      success: true,
      msg: 'Report saved (Dev File Fallback). No name or phone was stored.',
      report: {
        id: report.id,
        category: report.category,
        locality: report.locality,
        description: report.description,
        lat: report.lat,
        lng: report.lng,
        createdAt: report.createdAt
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API-level health and readiness endpoints.
router.get('/health', healthHandler);
router.get('/ready', readyHandler);

app.use('/api', router);

// ═══════════════════════════════════════════════════════════════
//  POLICE DASHBOARD — Serve static HTML
// ═══════════════════════════════════════════════════════════════
app.get('/police-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'police-dashboard.html'));
});

// ═══════════════════════════════════════════════════════════════
//  SOCKET.IO — Real-time Communication
// ═══════════════════════════════════════════════════════════════
const liveTrackingData = {};

io.on('connection', (socket) => {
  console.log(`[BACKEND] Connected Client: ${socket.id}`);

  // ── GPS Location Update ──
  socket.on('location-update', (data) => {
    liveTrackingData[socket.id] = data;
    // Broadcast back for Family Dashboard
    io.emit('family-dashboard-sync', liveTrackingData);

    // Update agent location + dispatch live location during emergencies
    const agentState = voiceAgent.getState(socket.id);
    if (agentState.status !== 'IDLE') {
      if (['EMERGENCY_PROTOCOL', 'RECORDING'].includes(agentState.status) && agentState.trackingId) {
        dispatchLiveLocation(io, {
          trackingId: agentState.trackingId,
          lat: data.lat,
          lng: data.lng,
          userName: agentState.userName,
          userPhone: agentState.userPhone
        });
      }
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  LANGGRAPH VOICE AGENT — Socket Handlers
  // ═══════════════════════════════════════════════════════════

  // ── Start monitoring (route search succeeded / Sarthi activated) ──
  socket.on('start-monitoring', (data) => {
    console.log(`[BACKEND] 🎤 Voice monitoring started for ${socket.id}`);
    voiceAgent.startMonitoring(socket.id, io, {
      name: data?.userName,
      phone: data?.userPhone,
      location: data?.location
    });
  });

  // ── Stop monitoring (route cleared / Sarthi disabled) ──
  socket.on('stop-monitoring', () => {
    console.log(`[BACKEND] 🔇 Voice monitoring stopped for ${socket.id}`);
    voiceAgent.stopMonitoring(socket.id, io);
  });

  // ── Process voice transcript from Sarvam AI ──
  // Intent: Hindi, Marathi, English transcripts only
  socket.on('voice-transcript', async (data) => {
    const { transcript, location } = data;
    if (!transcript || transcript.trim().length === 0) return;

    console.log(`[BACKEND] 🎤 Voice transcript from ${socket.id}: "${transcript.substring(0, 60)}..."`);
    await voiceAgent.processTranscript(socket.id, transcript, location, io);
  });

  // ── User clicked "I'm Safe" during intercept countdown ──
  socket.on('intercept-cancel', () => {
    console.log(`[BACKEND] ✅ Intercept cancelled by ${socket.id}`);
    voiceAgent.cancelIntercept(socket.id, io);
  });

  // ── User confirmed safety (stop recording, resolve emergency) ──
  socket.on('safety-confirmed', () => {
    console.log(`[BACKEND] ✅ Safety confirmed by ${socket.id}`);
    voiceAgent.resolveEmergency(socket.id, io, 'Safety confirmed by user');
  });

  // ── Evidence chunk upload via socket ──
  socket.on('evidence-upload', async (data) => {
    try {
      const { trackingId, audioData, format, trackingSecret } = data || {};
      if (!audioData || !trackingId) return;
      const buffer = Buffer.from(audioData);

      // Verify user identity strictly through authenticated socket session (never trust client payload)
      let verifiedUserId = null;
      if (socket.user?.userId) {
        verifiedUserId = socket.user.userId;
      } else if (socket.handshake?.auth?.token) {
        const payload = verifyToken(socket.handshake.auth.token);
        if (payload) verifiedUserId = payload.userId;
      }

      const result = await saveEvidence(
        trackingId,
        buffer,
        format || 'webm',
        verifiedUserId,
        trackingSecret || null
      );

      console.log(`[BACKEND] 📦 Evidence chunk saved for ${trackingId}:`, result.evidenceId || result.fileName);
      socket.emit('evidence-saved', {
        success: true,
        trackingId,
        evidenceId: result.evidenceId,
        trackingSecret: result.trackingSecret || null
      });
    } catch (err) {
      console.error(`[BACKEND] ❌ Evidence chunk upload failed:`, err.message);
      socket.emit('evidence-error', { success: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  ENHANCED SOS TRIGGER — Finds nearest station & dispatches
  // ═══════════════════════════════════════════════════════════
  socket.on('trigger-sos', async (data) => {
    const userLat = data?.lat || 0;
    const userLng = data?.lng || 0;
    const googleMapsLink = `https://maps.google.com/maps?q=${userLat},${userLng}`;

    console.log('\n═══════════════════════════════════════════════');
    console.log('🚨🚨🚨 EMERGENCY SOS DETECTED 🚨🚨🚨');
    console.log('═══════════════════════════════════════════════');
    console.log(`📍 User Location: ${userLat}, ${userLng}`);
    console.log(`🗺️  Google Maps: ${googleMapsLink}`);
    console.log(`⏰ Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);

    let nearestStation = null;
    const nearestResult = await findNearestPoliceStation(userLat, userLng);
    if (nearestResult && nearestResult.station) {
      nearestStation = nearestResult.station;
    }

    if (nearestStation) {
      console.log('───────────────────────────────────────────────');
      console.log(`🚔 NEAREST POLICE STATION: ${nearestStation.name}`);
      console.log(`📞 Phone: ${Array.isArray(nearestStation.phone) ? nearestStation.phone.join(', ') : nearestStation.phone}`);
      console.log(`📧 Email: ${nearestStation.email}`);
      console.log(`👮 Officer: ${nearestStation.officerInCharge || 'N/A'}`);
      console.log(`📏 Distance: ${nearestStation.distanceText}`);
      console.log('═══════════════════════════════════════════════\n');
    }

    // Broadcast to ALL connected clients (police dashboard, family)
    io.emit('emergency-broadcast-sent', {
      source: socket.id,
      loc: { lat: userLat, lng: userLng },
      googleMapsLink,
      nearestStation,
      timestamp: new Date().toISOString()
    });

    socket.emit('sos-station-info', {
      nearestStation,
      userLocation: { lat: userLat, lng: userLng, googleMapsLink, timestamp: new Date().toISOString() }
    });

    // Full emergency dispatch (Email + SMS + Location + Dashboard)
    try {
      const dispatchResults = await dispatchFullEmergency(io, {
        trackingId: `SOS-${Date.now().toString(36).toUpperCase()}`,
        userName: data?.userName || 'SOS User',
        userPhone: data?.userPhone || 'N/A',
        location: { lat: userLat, lng: userLng },
        transcript: data?.transcript || 'Manual SOS button pressed',
        severity: 'critical',
        detectedLanguage: data?.detectedLanguage || 'unknown',
        nearestStation,
        timestamp: new Date().toISOString()
      });

      socket.emit('dispatch-results', {
        emailSent: dispatchResults.email?.success || false,
        smsSent: dispatchResults.sms?.success || false,
        locationStreaming: dispatchResults.liveLocation?.success || false,
        emailMessageId: dispatchResults.email?.messageId || null
      });

      console.log(`[SOS] ✅ Full dispatch complete — email: ${dispatchResults.email?.success}, sms: ${dispatchResults.sms?.success}`);
    } catch (dispatchErr) {
      console.error('[SOS] ❌ Dispatch error:', dispatchErr.message);
    }
  });

  socket.on('sarthi-mode-engaged', (data) => {
    console.log(`\n[BACKEND] Sarthi Mode engaged on socket ${socket.id} (Stopped for 30s).`);
  });

  socket.on('disconnect', () => {
    delete liveTrackingData[socket.id];
    io.emit('family-dashboard-sync', liveTrackingData);
    voiceAgent.cleanupAgent(socket.id);
    console.log(`[BACKEND] Disconnected Client: ${socket.id}`);
  });
});

// ═══════════════════════════════════════════════════════════════
//  WEBRTC SIGNALING SETUP
// ═══════════════════════════════════════════════════════════════
setupWebRTCSignaling(io);

// ═══════════════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════════════
if (require.main === module) {
  const PORT = process.env.PORT || 5001;

  server.listen(PORT, () => {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  🛡️  SAKHI SAHAYAK — Full Stack Server (LangGraph Edition)');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  📡  Port          : ${PORT}`);
    console.log(`  🎤  Sarvam AI STT : ${process.env.SARVAM_API_KEY ? '✅ Configured (Hindi/Marathi/English)' : '❌ Missing SARVAM_API_KEY'}`);
    console.log(`  🤖  OpenRouter LLM: ${process.env.OPENROUTER_API_KEY ? '✅ Configured (GPT-4o-mini)' : '❌ Missing OPENROUTER_API_KEY'}`);
    console.log(`  📧  Resend Email  : ${process.env.RESEND_API ? `✅ Configured → ${EMERGENCY_EMAIL}` : '❌ Missing RESEND_API'}`);
    console.log(`  📱  Fast2SMS      : ${process.env.FAST2SMS_API_KEY ? `✅ Configured → +91 ${EMERGENCY_PHONE}` : '⚠️ Not set (email bridge fallback)'}`);
    console.log(`  🚔  Police Dashboard : http://localhost:${PORT}/police-dashboard`);
    console.log(`  📦  Evidence Dir  : ${EVIDENCE_DIR}`);
    console.log('  ⚡  LangGraph States: IDLE→MONITORING→THREAT_DETECTED→');
    console.log('      INTERCEPT_COUNTDOWN→EMERGENCY_PROTOCOL→RECORDING→RESOLVED');
    console.log('═══════════════════════════════════════════════════════════════\n');
  });
}

module.exports = { app, server, io };
