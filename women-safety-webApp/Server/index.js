require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const User = require('./models/User');
const PoliceStation = require('./models/PoliceStation');

// ── LangGraph/Voice Agent Modules ──
const voiceAgent = require('./voiceAgent');
const { setupWebRTCSignaling } = require('./webrtcSignaling');
const { saveEvidence, listEvidence, EVIDENCE_DIR } = require('./evidenceRecorder');
const { dispatchFullEmergency, dispatchLiveLocation, EMERGENCY_EMAIL, EMERGENCY_PHONE } = require('./emergencyDispatcher');

const app = express();
const server = http.createServer(app);

// Cross-Origin configuration
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 10 * 1024 * 1024 // 10MB for audio uploads
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

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Lightweight health check — intentionally independent of database connectivity.
const healthHandler = (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'sakhi-backend',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
};

// Direct health endpoint for Docker and infrastructure monitoring.
app.get('/health', healthHandler);

// Serve evidence files statically
app.use('/evidence', express.static(EVIDENCE_DIR));

// Multer config for audio/evidence upload (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

let isMongoConnected = false;
const memoryUsers = []; // Fallback memory database

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000
}).then(() => {
  isMongoConnected = true;
  console.log('✅ Connected explicitly to MongoDB (Sakhi Cluster)');
}).catch(err => {
  console.log('⚠️ MongoDB Blocked (IP Whitelist Issue). Using Memory Database for Demo.');
});

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

// ═══════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════
const router = express.Router();

// ── Auth: Signup ──
router.post('/signup', async (req, res) => {
  try {
    const { userName, userPhone, userPassword, emergencyName, emergencyPhone } = req.body;

    if (!isMongoConnected) {
      if (memoryUsers.find(u => u.phone === userPhone)) {
        return res.status(400).json({ success: false, msg: 'User already exists! Please login.' });
      }
      const newUser = { name: userName, phone: userPhone, password: userPassword, emergencyContact: { name: emergencyName, phone: emergencyPhone } };
      memoryUsers.push(newUser);
      return res.status(201).json({ success: true, user: newUser, msg: 'Signup successful (Memory Mode)' });
    }

    let existingUser = await User.findOne({ phone: userPhone });
    if (existingUser) {
      return res.status(400).json({ success: false, msg: 'User with this phone number already exists! Please login.' });
    }

    const newUser = new User({
      name: userName,
      phone: userPhone,
      password: userPassword,
      emergencyContact: { name: emergencyName, phone: emergencyPhone }
    });
    await newUser.save();
    return res.status(201).json({ success: true, user: newUser, msg: 'Signup successful!' });
  } catch (err) {
    console.error('Signup Route Error: ', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Auth: Login ──
router.post('/login', async (req, res) => {
  try {
    const { userPhone, userPassword } = req.body;

    if (!isMongoConnected) {
      const user = memoryUsers.find(u => u.phone === userPhone);
      if (!user) return res.status(200).json({ success: false, msg: 'User not found! (Memory Mode)' });
      if (user.password !== userPassword) return res.status(200).json({ success: false, msg: 'Invalid password!' });
      return res.status(200).json({ success: true, user: user, msg: 'Login successful!' });
    }

    const user = await User.findOne({ phone: userPhone });
    if (!user) return res.status(200).json({ success: false, msg: 'User not found!' });
    if (user.password !== userPassword) return res.status(200).json({ success: false, msg: 'Invalid password!' });
    return res.status(200).json({ success: true, user: user, msg: 'Login successful!' });
  } catch (err) {
    console.error('Login Route Error: ', err);
    res.status(500).json({ success: false, error: err.message });
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

router.get('/nearest', (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'safety_data.json'), 'utf8'));
    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);

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
      police_station: findNearest(data.police_stations),
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

    // Try MongoDB geospatial query first
    if (isMongoConnected) {
      try {
        const nearestStation = await PoliceStation.findOne({
          location: {
            $near: {
              $geometry: { type: 'Point', coordinates: [userLng, userLat] },
              $maxDistance: 50000
            }
          },
          category: 'station'
        });

        if (nearestStation) {
          const distance = haversineDistance(userLat, userLng, nearestStation.lat, nearestStation.lng);
          return res.json({
            success: true,
            source: 'mongodb',
            station: {
              name: nearestStation.name,
              phone: nearestStation.phone,
              email: nearestStation.email,
              zone: nearestStation.zone,
              officerInCharge: nearestStation.officerInCharge,
              type: nearestStation.type,
              lat: nearestStation.lat,
              lng: nearestStation.lng,
              address: nearestStation.address,
              description: nearestStation.description,
              distance,
              distanceText: distance > 1 ? `${distance.toFixed(1)} km` : `${(distance * 1000).toFixed(0)} m`
            },
            userLocation: { lat: userLat, lng: userLng, googleMapsLink: `https://maps.google.com/maps?q=${userLat},${userLng}`, timestamp: new Date().toISOString() }
          });
        }
      } catch (geoErr) {
        console.log('⚠️ MongoDB geospatial query failed, using JSON fallback:', geoErr.message);
      }
    }

    // Fallback: Use safety_data.json
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'safety_data.json'), 'utf8'));
    const stations = data.police_stations || [];
    let nearest = null;
    let minDist = Infinity;

    stations.forEach(station => {
      const d = haversineDistance(userLat, userLng, station.lat, station.lng);
      if (d < minDist) { minDist = d; nearest = { ...station, distance: d }; }
    });

    if (nearest) {
      return res.json({
        success: true,
        source: 'json_fallback',
        station: {
          name: nearest.name,
          phone: [nearest.contact].filter(Boolean),
          email: nearest.email || '',
          zone: '',
          officerInCharge: '',
          type: 'city',
          lat: nearest.lat,
          lng: nearest.lng,
          address: '',
          description: nearest.description,
          distance: nearest.distance,
          distanceText: nearest.distance > 1 ? `${nearest.distance.toFixed(1)} km` : `${(nearest.distance * 1000).toFixed(0)} m`
        },
        userLocation: { lat: userLat, lng: userLng, googleMapsLink: `https://maps.google.com/maps?q=${userLat},${userLng}`, timestamp: new Date().toISOString() }
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
    if (isMongoConnected) {
      const stations = await PoliceStation.find({ category: 'station' }).select('-__v');
      return res.json({ success: true, count: stations.length, stations });
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
router.post('/upload-evidence', upload.single('evidence'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No evidence file provided'
      });
    }

    const trackingId = req.body.trackingId || 'UNKNOWN';

    // Validate client input before writing any files.
    if (
      typeof trackingId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(trackingId)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid tracking ID'
      });
    }

    const result = await saveEvidence(
      trackingId,
      req.file.buffer,
      'webm'
    );

    if (process.env.S3_EVIDENCE_BUCKET && !result.s3Url) {
      return res.status(502).json({
        success: false,
        error: 'Evidence could not be uploaded to S3'
      });
    }

    return res.json({ success: true, ...result });

  } catch (err) {
    console.error('[Evidence Upload] Error:', err.message);

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ── Evidence Listing ──
router.get('/evidence/:trackingId', (req, res) => {
  try {
    const files = listEvidence(req.params.trackingId);
    res.json({ success: true, trackingId: req.params.trackingId, files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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

router.get('/safety-reports', (req, res) => {
  try {
    const data = readJsonFile(REPORTS_FILE, { reports: [] });
    const reports = (data.reports || []).map(r => ({
      id: r.id,
      category: r.category,
      locality: r.locality,
      description: r.description,
      lat: r.exact ? r.lat : coarseCoord(r.lat),
      lng: r.exact ? r.lng : coarseCoord(r.lng),
      createdAt: r.createdAt
    }));
    res.json({ success: true, count: reports.length, reports });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/safety-reports', (req, res) => {
  try {
    const { category, locality, description, lat, lng, shareExact } = req.body || {};
    if (!category || !description) {
      return res.status(400).json({ success: false, msg: 'Category and description are required.' });
    }

    const parsedLat = lat !== undefined && lat !== '' ? parseFloat(lat) : null;
    const parsedLng = lng !== undefined && lng !== '' ? parseFloat(lng) : null;
    const exact = Boolean(shareExact) && parsedLat !== null && parsedLng !== null;

    const report = {
      id: `r-${Date.now()}`,
      category: String(category).slice(0, 80),
      locality: String(locality || 'Area withheld').slice(0, 120),
      description: String(description).slice(0, 800),
      lat: parsedLat,
      lng: parsedLng,
      exact,
      createdAt: new Date().toISOString()
    };

    const data = readJsonFile(REPORTS_FILE, { reports: [] });
    data.reports = data.reports || [];
    data.reports.unshift(report);
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(data, null, 2));

    res.status(201).json({
      success: true,
      msg: 'Report saved. No name or phone was stored.',
      report: {
        id: report.id,
        category: report.category,
        locality: report.locality,
        description: report.description,
        lat: exact ? report.lat : (report.lat === null ? null : coarseCoord(report.lat)),
        lng: exact ? report.lng : (report.lng === null ? null : coarseCoord(report.lng)),
        createdAt: report.createdAt
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API-level health endpoint.
router.get('/health', healthHandler);

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
  socket.on('evidence-upload', (data) => {
    const { trackingId, audioData, format } = data;
    if (!audioData || !trackingId) return;
    const buffer = Buffer.from(audioData);
    saveEvidence(trackingId, buffer, format || 'webm');
    console.log(`[BACKEND] 📦 Evidence chunk saved for ${trackingId}`);
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

    // Try MongoDB geospatial lookup
    if (isMongoConnected) {
      try {
        const station = await PoliceStation.findOne({
          location: {
            $near: {
              $geometry: { type: 'Point', coordinates: [userLng, userLat] },
              $maxDistance: 50000
            }
          },
          category: 'station'
        });

        if (station) {
          const distance = haversineDistance(userLat, userLng, station.lat, station.lng);
          nearestStation = {
            name: station.name,
            phone: station.phone,
            email: station.email,
            zone: station.zone,
            officerInCharge: station.officerInCharge,
            type: station.type,
            lat: station.lat,
            lng: station.lng,
            distance,
            distanceText: distance > 1 ? `${distance.toFixed(1)} km` : `${(distance * 1000).toFixed(0)} m`
          };
        }
      } catch (err) {
        console.log('⚠️ MongoDB lookup failed during SOS:', err.message);
      }
    }

    // Fallback to JSON
    if (!nearestStation) {
      try {
        const safetyData = JSON.parse(fs.readFileSync(path.join(__dirname, 'safety_data.json'), 'utf8'));
        const stations = safetyData.police_stations || [];
        let minDist = Infinity;

        stations.forEach(s => {
          const d = haversineDistance(userLat, userLng, s.lat, s.lng);
          if (d < minDist) {
            minDist = d;
            nearestStation = {
              name: s.name,
              phone: [s.contact].filter(Boolean),
              email: s.email || '',
              zone: '',
              officerInCharge: '',
              type: 'city',
              lat: s.lat,
              lng: s.lng,
              distance: d,
              distanceText: d > 1 ? `${d.toFixed(1)} km` : `${(d * 1000).toFixed(0)} m`
            };
          }
        });
      } catch (jsonErr) {
        console.log('⚠️ JSON fallback also failed:', jsonErr.message);
      }
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
