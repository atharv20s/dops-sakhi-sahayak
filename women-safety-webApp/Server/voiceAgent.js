// ═══════════════════════════════════════════════════════════════════════════
//  VOICE AGENT — LangGraph State Machine (Full Implementation)
//
//  States: IDLE → MONITORING → THREAT_DETECTED → INTERCEPT_COUNTDOWN
//          → EMERGENCY_PROTOCOL → RECORDING → RESOLVED → MONITORING
//
//  Privacy-first: No audio/memory stored unless distress is confirmed.
//  Sarvam AI handles STT (Hindi, Marathi, English ONLY).
//  OpenRouter GPT-4o-mini confirms threats via orchestrator.
//  send-email.js dispatches emails on confirmed threats.
// ═══════════════════════════════════════════════════════════════════════════

const { analyzeTranscript, getNearestPolice, STATES, isValidTransition, getEdgeCondition } = require('./orchestrator');
const { saveEvidence, createMetadata } = require('./evidenceRecorder');
const { dispatchFullEmergency, dispatchLiveLocation } = require('./emergencyDispatcher');
const { sendEmergencyEmail } = require('./send-email');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════
//  DISTRESS KEYWORDS — Hindi, Marathi, English (Strict Trilingual)
//
//  Local gate checked BEFORE calling the LLM to reduce false API calls.
// ═══════════════════════════════════════════════════════════════

const DISTRESS_KEYWORDS = {
  english: [
    'help', 'save me', 'stop', 'please no', 'leave me', "don't touch",
    'someone help', 'let me go', 'get away', 'call police', 'i am scared',
    'please help', 'he is following', 'following me', 'kidnap', 'attack',
    'assault', 'rape', 'molest', 'harass', 'threatening', 'stalking',
    'i need help', 'someone is following me', "don't hurt me", 'call 911',
    'help me', 'stay away', 'leave me alone', 'stop it', 'no please',
    'somebody help', 'save me please', 'get off me', 'police'
  ],
  hindi_roman: [
    'bachao', 'madad', 'chhodo', 'mat karo', 'koi hai', 'police bulao',
    'mujhe bachao', 'chhoddo', 'jane do', 'ruko', 'koi madad karo',
    'dar lag raha', 'peecha kar raha', 'maar raha', 'pakad liya',
    'help karo', 'bachao koi', 'mujhe chhoddo', 'hato', 'hatiye',
    'koi bachao', 'mujhe chhodo', 'police ko call karo', 'mujhe maar raha hai',
    'chhod do', 'kya kar rahe ho', 'dur raho', 'mat chuo', 'mujhe mat chuo',
    'madad karo', 'koi to madad karo', 'mujhe jane do', 'peeche pad gaya',
    'bachaao', 'baचao', 'madat', 'chodo', 'chod do', 'mujhe chodo'
  ],
  // ── Devanagari Hindi (what Sarvam AI actually returns) ──
  hindi_devanagari: [
    'बचाओ', 'मदद', 'छोड़ो', 'मत करो', 'कोई है', 'पुलिस बुलाओ',
    'मुझे बचाओ', 'छोड़ दो', 'जाने दो', 'रुको', 'कोई मदद करो',
    'डर लग रहा', 'पीछा कर रहा', 'मार रहा', 'पकड़ लिया',
    'हेल्प करो', 'बचाओ कोई', 'मुझे छोड़ दो', 'हटो', 'हटिये',
    'कोई बचाओ', 'मुझे छोड़ो', 'पुलिस को कॉल करो', 'मुझे मार रहा है',
    'छोड़ दो', 'क्या कर रहे हो', 'दूर रहो', 'मत छुओ', 'मुझे मत छुओ',
    'मदद करो', 'कोई तो मदद करो', 'मुझे जाने दो', 'पीछे पड़ गया',
    'हेल्प', 'मदद चाहिए', 'बचाओ मुझे', 'पुलिस', 'कोई तो आओ',
    'मुझे बचा लो', 'मार डालेगा', 'मार रहा है', 'पकड़ लिया है',
    'छोड़ दे', 'हट जा', 'हट जाओ', 'दूर हट', 'दूर हटो',
    'कोई सुनो', 'कोई आओ', 'बचा लो', 'सहायता', 'मदद कीजिए'
  ],
  marathi_roman: [
    'vachva', 'madad kara', 'sodha', 'naka karu', 'polees bolva',
    'koni ahe ka', 'sahayya kara', 'mala sodha', 'thamba', 'mala vachva',
    'paathlag karto', 'bhiti vatay', 'mala dhara', 'madat kara',
    'polees bolava', 'madad havi', 'mala jaau dya', 'dur raha',
    'koni tari ya', 'mala sparsh karu naka', 'mala madat kara',
    'koni madatila ya ka', 'sagla theek nahi'
  ],
  // ── Devanagari Marathi (what Sarvam AI actually returns) ──
  marathi_devanagari: [
    'वाचवा', 'मदत करा', 'सोडा', 'नका करू', 'पोलीस बोलवा',
    'कोणी आहे का', 'सहाय्य करा', 'मला सोडा', 'थांबा', 'मला वाचवा',
    'पाठलाग करतो', 'भीती वाटतय', 'मला धरा', 'मदत करा',
    'पोलीस बोलवा', 'मदत हवी', 'मला जाऊ द्या', 'दूर राहा',
    'कोणी तरी या', 'मला स्पर्श करू नका', 'मला मदत करा',
    'कोणी मदतीला या का', 'सगळं ठीक नाही',
    'पोलीस', 'मदत', 'वाचवा मला', 'सोड', 'सोडा मला',
    'कोणी या', 'मला मारतोय', 'मला पकडलं', 'सोड दे'
  ]
};

// Flatten all keywords into a single lowercase array for fast lookups
const ALL_KEYWORDS_LIST = Object.values(DISTRESS_KEYWORDS)
  .flat()
  .map(k => k.toLowerCase().trim());

// Also create a Set for single-word fast lookups
const ALL_KEYWORDS = new Set(ALL_KEYWORDS_LIST);

// ═══════════════════════════════════════════════════════════════
//  SUSPICIOUS SOUND PATTERNS — Non-verbal distress indicators
//
//  Sarvam AI / Whisper may transcribe ambient sounds as descriptive
//  text. These patterns catch screaming, crying, breaking glass, etc.
// ═══════════════════════════════════════════════════════════════

const SUSPICIOUS_SOUND_PATTERNS = [
  // Screaming / shouting patterns
  'scream', 'screaming', 'shriek', 'shrieking', 'yelling', 'shouting',
  'crying', 'sobbing', 'wailing', 'whimpering', 'weeping',
  // Physical violence sounds
  'glass breaking', 'breaking glass', 'bang', 'crash', 'slap', 'hitting',
  'gunshot', 'gun shot', 'explosion', 'thud', 'smash',
  // Distress vocalizations (often transcribed by STT)
  'ahhh', 'aaah', 'aaaa', 'noooo', 'nooo',
  // Hindi/Marathi distress sounds
  'chillana', 'rona', 'cheekh', 'cheekh rahi', 'chillao',
  'chikh', 'chikhi', 'kiski awaaz'
];

/**
 * Normalize text: strip punctuation, extra spaces, Devanagari punctuation (।, !) etc.
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[!?.,'"\-_।॥()\[\]{}]/g, ' ')  // strip punctuation including Devanagari danda
    .replace(/\s+/g, ' ')                       // collapse whitespace
    .trim();
}

/**
 * Enhanced keyword matching — handles Devanagari + romanized + partial matches
 * Returns all matched keywords from the transcript
 */
function findDistressKeywords(transcript) {
  const normalized = normalizeText(transcript);
  const matched = [];

  // Check every keyword (both Devanagari and romanized) against the transcript
  for (const keyword of ALL_KEYWORDS_LIST) {
    const normKeyword = normalizeText(keyword);
    if (normKeyword.length < 2) continue; // skip tiny strings

    // Direct substring match in normalized transcript
    if (normalized.includes(normKeyword)) {
      matched.push(keyword);
    }
  }

  return [...new Set(matched)]; // deduplicate
}

/**
 * Detect which language a keyword belongs to
 */
function detectKeywordLanguage(matchedKeywords) {
  let scores = { 'en-IN': 0, 'hi-IN': 0, 'mr-IN': 0 };

  for (const kw of matchedKeywords) {
    const lower = kw.toLowerCase();
    if (DISTRESS_KEYWORDS.english.includes(lower)) scores['en-IN']++;
    if (DISTRESS_KEYWORDS.hindi_roman.includes(lower)) scores['hi-IN']++;
    if (DISTRESS_KEYWORDS.hindi_devanagari.includes(lower)) scores['hi-IN']++;
    if (DISTRESS_KEYWORDS.marathi_roman.includes(lower)) scores['mr-IN']++;
    if (DISTRESS_KEYWORDS.marathi_devanagari.includes(lower)) scores['mr-IN']++;
    // Detect Devanagari script presence
    if (/[\u0900-\u097F]/.test(kw)) {
      // It's Devanagari — check if more Hindi or Marathi
      if (DISTRESS_KEYWORDS.hindi_devanagari.some(d => kw.includes(d))) scores['hi-IN']++;
      if (DISTRESS_KEYWORDS.marathi_devanagari.some(d => kw.includes(d))) scores['mr-IN']++;
    }
  }

  // Return the language with highest score
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : 'unknown';
}

// ═══════════════════════════════════════════════════════════════
//  AGENT STATE STORE (per socket/user)
// ═══════════════════════════════════════════════════════════════

const agentStates = new Map();

function createAgentState(socketId, userData = {}) {
  return {
    status: STATES.IDLE,
    userId: socketId,
    userName: userData.name || null,
    userPhone: userData.phone || null,
    currentLocation: null,
    threatTranscript: null,
    threatSeverity: null,
    detectedLanguage: null,
    interceptTimerId: null,
    recordingStartTime: null,
    recordingTimerId: null,
    trackingId: null,
    nearestPolice: null,
    createdAt: Date.now(),
    stateHistory: [{ state: STATES.IDLE, timestamp: Date.now(), reason: 'Agent initialized' }]
  };
}

function getState(socketId) {
  if (!agentStates.has(socketId)) {
    agentStates.set(socketId, createAgentState(socketId));
  }
  return agentStates.get(socketId);
}

function setState(socketId, updates) {
  const current = getState(socketId);
  const newState = { ...current, ...updates };
  agentStates.set(socketId, newState);
  return newState;
}

function logTransition(socketId, from, to, reason) {
  const valid = isValidTransition(from, to);
  const edgeLabel = getEdgeCondition(from, to);

  console.log(`\n[VoiceAgent] ⚡ LANGGRAPH STATE TRANSITION for ${socketId}`);
  console.log(`  ${from} → ${to}`);
  console.log(`  Edge: ${edgeLabel}`);
  console.log(`  Reason: ${reason}`);
  console.log(`  Valid: ${valid ? '✅' : '⚠️ UNEXPECTED'}`);
  console.log(`  Time: ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}\n`);

  // Record in state history
  const state = getState(socketId);
  if (state.stateHistory) {
    state.stateHistory.push({ state: to, timestamp: Date.now(), reason, edge: edgeLabel });
  }
}

// ═══════════════════════════════════════════════════════════════
//  CORE STATE MACHINE FUNCTIONS
//  Matches the LangGraph diagram exactly
// ═══════════════════════════════════════════════════════════════

/**
 * LangGraph Edge: IDLE → MONITORING
 * Condition: Route started / Sarthi activated
 */
function startMonitoring(socketId, io, userData = {}) {
  const state = getState(socketId);
  const oldStatus = state.status;

  setState(socketId, {
    status: STATES.MONITORING,
    userName: userData.name || state.userName,
    userPhone: userData.phone || state.userPhone,
    currentLocation: userData.location || state.currentLocation,
    detectedLanguage: null
  });

  logTransition(socketId, oldStatus, STATES.MONITORING, 'Route started / monitoring activated');

  io.to(socketId).emit('agent-state-update', {
    status: STATES.MONITORING,
    message: 'Voice monitoring active. Listening for distress signals in Hindi, Marathi & English.',
    langGraphState: STATES.MONITORING,
    supportedLanguages: ['hi-IN', 'mr-IN', 'en-IN']
  });
}

/**
 * LangGraph Edge: MONITORING → IDLE
 * Condition: Route ended / Sarthi disabled
 */
function stopMonitoring(socketId, io) {
  const state = getState(socketId);

  // Clear any active timers
  if (state.interceptTimerId) clearTimeout(state.interceptTimerId);
  if (state.recordingTimerId) clearTimeout(state.recordingTimerId);

  const oldStatus = state.status;
  setState(socketId, {
    status: STATES.IDLE,
    threatTranscript: null,
    threatSeverity: null,
    detectedLanguage: null,
    interceptTimerId: null,
    recordingStartTime: null,
    recordingTimerId: null,
    trackingId: null,
    nearestPolice: null
  });

  logTransition(socketId, oldStatus, STATES.IDLE, 'Route ended / monitoring stopped');

  io.to(socketId).emit('agent-state-update', {
    status: STATES.IDLE,
    message: 'Voice monitoring stopped.',
    langGraphState: STATES.IDLE
  });
}

/**
 * LangGraph Node: MONITORING
 * Process a transcript — first checks local keywords, then calls orchestrator LLM
 */
async function processTranscript(socketId, transcript, location, io) {
  const state = getState(socketId);

  // Only process if we're in MONITORING state
  if (state.status !== STATES.MONITORING) {
    console.log(`[VoiceAgent] Ignoring transcript — status is ${state.status}, not MONITORING`);
    return;
  }

  // Update location
  setState(socketId, { currentLocation: location });

  const lowerTranscript = transcript.toLowerCase().trim();
  const normalizedTranscript = normalizeText(transcript);

  console.log(`[VoiceAgent] 🔍 Analyzing transcript: "${transcript}"`);
  console.log(`[VoiceAgent] 🔍 Normalized: "${normalizedTranscript}"`);

  // ── Enhanced keyword gate (handles Devanagari + romanized) ──
  const matchedKeywords = findDistressKeywords(transcript);

  // ── Suspicious sound detection ──
  const matchedSounds = [];
  for (const pattern of SUSPICIOUS_SOUND_PATTERNS) {
    if (normalizedTranscript.includes(pattern)) {
      matchedSounds.push(pattern);
    }
  }

  const isDistress = matchedKeywords.length > 0 || matchedSounds.length > 0;

  if (!isDistress) {
    // No distress keywords or suspicious sounds — discard transcript, stay in MONITORING
    console.log(`[VoiceAgent] ✅ No distress keywords in: "${transcript.substring(0, 80)}"`);
    io.to(socketId).emit('voice-analysis', {
      transcript,
      distress: false,
      keywords: [],
      action: 'no_action',
      langGraphState: STATES.MONITORING
    });
    return;
  }

  // Detect language from matched keywords
  const allMatched = [...matchedKeywords, ...matchedSounds];
  const keywordLanguage = matchedKeywords.length > 0
    ? detectKeywordLanguage(matchedKeywords)
    : 'unknown';

  if (matchedKeywords.length > 0) {
    console.log(`[VoiceAgent] 🚨 DISTRESS KEYWORDS MATCHED: ${matchedKeywords.join(', ')}`);
  }
  if (matchedSounds.length > 0) {
    console.log(`[VoiceAgent] 🔊 SUSPICIOUS SOUNDS DETECTED: ${matchedSounds.join(', ')}`);
  }
  console.log(`[VoiceAgent] ⚡ BYPASSING LLM: Commencing Immediate SOS protocols to ensure zero-latency response.`);

  // ── Look up nearest police station for email content ──
  let nearestStation = null;
  if (location && location.lat && location.lng) {
    nearestStation = getNearestPolice(location.lat, location.lng);
    if (nearestStation) {
      console.log(`[VoiceAgent] 🚔 Nearest Police Station: ${nearestStation.name} (${nearestStation.distanceText} away) — Phone: ${nearestStation.contact || 'N/A'}`);
    }
  }

  // ── Modified: INSTANT KEYWORD TRIGGER (Bypass LLM completely for strict, rapid SOS) ──
  const trackingId = `TRK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  setState(socketId, {
    status: STATES.THREAT_DETECTED,
    threatTranscript: transcript,
    threatSeverity: 'critical',
    detectedLanguage: keywordLanguage,
    trackingId: trackingId,
    nearestPolice: nearestStation
  });

  const triggerReason = matchedSounds.length > 0 && matchedKeywords.length === 0
    ? `Suspicious sounds detected: ${matchedSounds.join(', ')}. Triggered instant SOS.`
    : `Distress keywords detected locally. Triggered instant SOS without API latency.`;

  io.to(socketId).emit('agent-state-update', {
    status: STATES.THREAT_DETECTED,
    trackingId: trackingId,
    message: 'Local Keywords matched! Emergency protocol instantly active.',
    langGraphState: STATES.THREAT_DETECTED,
    langGraphEdge: 'strict_keyword_match',
    nearestStation: nearestStation
  });

  io.to(socketId).emit('voice-analysis', {
    transcript,
    distress: true,
    keywords: allMatched,
    action: 'threat_confirmed',
    severity: 'critical',
    summary: triggerReason,
    detectedLanguage: keywordLanguage,
    langGraphState: STATES.THREAT_DETECTED,
    nearestStation: nearestStation
  });

  // Execute directly, identical to manual SOS button
  await executeEmergencyProtocol(socketId, io);
  return;

  // ── LLM code below is intentionally unreachable due to explicit bypass ──
  try {
    const userInfo = {
      name: state.userName || 'Unknown User',
      phone: state.userPhone || 'N/A',
      socketId: socketId
    };

    const llmResult = await analyzeTranscript(transcript, location, userInfo);

    console.log(`[VoiceAgent] Orchestrator LLM result:`, JSON.stringify(llmResult));

    // Handle orchestrator response
    await handleOrchestratorResponse(socketId, llmResult, transcript, io, keywordLanguage);

  } catch (err) {
    console.error(`[VoiceAgent] Orchestrator LLM error:`, err.message);

    // Fallback: if LLM fails but keywords matched, still escalate (safety first)
    console.log(`[VoiceAgent] ⚠️ LLM failed — escalating based on keyword match alone (safety first)`);
    await handleOrchestratorResponse(socketId, {
      action: 'trigger_emergency_alert',
      severity: 'high',
      summary: `Distress keywords detected: ${matchedKeywords.join(', ')}. LLM confirmation failed, escalating as precaution.`,
      detectedLanguage: keywordLanguage
    }, transcript, io, keywordLanguage);
  }
}

/**
 * LangGraph Edge: MONITORING → THREAT_DETECTED
 * Condition: Orchestrator LLM confirms distress
 */
async function handleOrchestratorResponse(socketId, llmResult, transcript, io, keywordLanguage) {
  const state = getState(socketId);

  if (llmResult.action === 'trigger_emergency_alert') {
    // ── Transition: MONITORING → THREAT_DETECTED ──
    const trackingId = `TRK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const detectedLang = llmResult.detectedLanguage || keywordLanguage || 'unknown';

    logTransition(socketId, state.status, STATES.THREAT_DETECTED, `LLM confirmed threat: ${llmResult.summary}`);

    setState(socketId, {
      status: STATES.THREAT_DETECTED,
      threatTranscript: transcript,
      threatSeverity: llmResult.severity || 'high',
      detectedLanguage: detectedLang,
      trackingId: trackingId,
      nearestPolice: llmResult.nearestStation || null
    });

    // Notify client immediately
    io.to(socketId).emit('agent-state-update', {
      status: STATES.THREAT_DETECTED,
      transcript,
      severity: llmResult.severity || 'high',
      summary: llmResult.summary,
      trackingId,
      detectedLanguage: detectedLang,
      langGraphState: STATES.THREAT_DETECTED,
      langGraphEdge: 'Orchestrator LLM confirms distress'
    });

    io.to(socketId).emit('voice-analysis', {
      transcript,
      distress: true,
      keywords: [],
      action: 'threat_confirmed',
      severity: llmResult.severity || 'high',
      summary: llmResult.summary,
      detectedLanguage: detectedLang,
      langGraphState: STATES.THREAT_DETECTED
    });

    // ── Modified: Instant Trigger (Bypass 5s countdown) ──
    // Condition: User requested immediate SOS activation upon threat detection
    executeEmergencyProtocol(socketId, io);

  } else {
    // LLM says no genuine threat — stay in MONITORING
    console.log(`[VoiceAgent] LLM verdict: No real threat. Continuing monitoring.`);

    io.to(socketId).emit('voice-analysis', {
      transcript,
      distress: false,
      keywords: [],
      action: 'no_action',
      summary: llmResult.summary || 'No threat detected.',
      detectedLanguage: llmResult.detectedLanguage || keywordLanguage || 'unknown',
      langGraphState: STATES.MONITORING
    });
  }
}

/**
 * LangGraph Edge: THREAT_DETECTED → INTERCEPT_COUNTDOWN
 * Condition: 5s timer starts
 *
 * If user doesn't click "I'm Safe" within 5s, escalate to EMERGENCY_PROTOCOL
 */
function startInterceptCountdown(socketId, io) {
  const state = getState(socketId);

  logTransition(socketId, state.status, STATES.INTERCEPT_COUNTDOWN, '5-second intercept timer started');

  setState(socketId, { status: STATES.INTERCEPT_COUNTDOWN });

  // Send countdown start to client
  io.to(socketId).emit('agent-state-update', {
    status: STATES.INTERCEPT_COUNTDOWN,
    countdown: 5,
    message: 'THREAT DETECTED! Click "I\'m Safe" within 5 seconds to cancel.',
    langGraphState: STATES.INTERCEPT_COUNTDOWN,
    langGraphEdge: '5s timer starts'
  });

  // Emit second-by-second countdown
  let remaining = 5;
  const countdownInterval = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      io.to(socketId).emit('intercept-countdown-tick', { remaining });
    }
  }, 1000);

  // Set 5-second timer
  const timerId = setTimeout(() => {
    clearInterval(countdownInterval);

    const currentState = getState(socketId);
    // Only escalate if still in INTERCEPT_COUNTDOWN (user didn't cancel)
    if (currentState.status === STATES.INTERCEPT_COUNTDOWN) {
      // LangGraph Edge: INTERCEPT_COUNTDOWN → EMERGENCY_PROTOCOL
      // Condition: 5s elapsed (no cancel)
      executeEmergencyProtocol(socketId, io);
    }
  }, 5000);

  setState(socketId, {
    interceptTimerId: timerId,
    _countdownInterval: countdownInterval
  });
}

/**
 * LangGraph Edge: INTERCEPT_COUNTDOWN → MONITORING (cancel path)
 * Condition: User clicks "I'm Safe"
 */
function cancelIntercept(socketId, io) {
  const state = getState(socketId);

  if (state.status !== STATES.INTERCEPT_COUNTDOWN && state.status !== STATES.THREAT_DETECTED) {
    console.log(`[VoiceAgent] Cannot cancel — not in INTERCEPT_COUNTDOWN state (current: ${state.status})`);
    return;
  }

  // Clear timers
  if (state.interceptTimerId) clearTimeout(state.interceptTimerId);
  if (state._countdownInterval) clearInterval(state._countdownInterval);

  logTransition(socketId, state.status, STATES.MONITORING, 'User clicked "I\'m Safe" — intercept cancelled');

  setState(socketId, {
    status: STATES.MONITORING,
    threatTranscript: null,
    threatSeverity: null,
    detectedLanguage: null,
    interceptTimerId: null,
    trackingId: null,
    nearestPolice: null
  });

  io.to(socketId).emit('agent-state-update', {
    status: STATES.MONITORING,
    message: 'Intercept cancelled. Returning to monitoring mode.',
    langGraphState: STATES.MONITORING,
    langGraphEdge: 'User clicks "I\'m Safe"'
  });
}

/**
 * LangGraph Edge: INTERCEPT_COUNTDOWN → EMERGENCY_PROTOCOL
 * Condition: 5s elapsed (no cancel)
 *
 * Dispatches alerts, starts tracking, sends email
 */
async function executeEmergencyProtocol(socketId, io) {
  const state = getState(socketId);

  logTransition(socketId, state.status, STATES.EMERGENCY_PROTOCOL, 'Intercept timer expired — ESCALATING');

  setState(socketId, { status: STATES.EMERGENCY_PROTOCOL });

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('🚨🚨🚨  LANGGRAPH: EMERGENCY_PROTOCOL ENGAGED  🚨🚨🚨');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  User: ${state.userName || 'Unknown'}`);
  console.log(`  Phone: ${state.userPhone || 'N/A'}`);
  console.log(`  Location: ${JSON.stringify(state.currentLocation)}`);
  console.log(`  Threat: "${state.threatTranscript}"`);
  console.log(`  Severity: ${state.threatSeverity}`);
  console.log(`  Language: ${state.detectedLanguage || 'unknown'}`);
  console.log(`  Tracking ID: ${state.trackingId}`);
  console.log('═══════════════════════════════════════════════════════\n');

  // Notify client
  io.to(socketId).emit('agent-state-update', {
    status: STATES.EMERGENCY_PROTOCOL,
    trackingId: state.trackingId,
    message: 'Emergency protocol active. Dispatching alerts and starting evidence recording.',
    langGraphState: STATES.EMERGENCY_PROTOCOL,
    langGraphEdge: '5s elapsed (no cancel)',
    detectedLanguage: state.detectedLanguage
  });

  // Broadcast emergency to police dashboard
  io.emit('emergency-alert', {
    trackingId: state.trackingId,
    userName: state.userName,
    userPhone: state.userPhone,
    location: state.currentLocation,
    transcript: state.threatTranscript,
    severity: state.threatSeverity,
    detectedLanguage: state.detectedLanguage || 'unknown',
    nearestPolice: state.nearestPolice,
    timestamp: new Date().toISOString(),
    langGraphState: STATES.EMERGENCY_PROTOCOL,
    googleMapsLink: state.currentLocation
      ? `https://maps.google.com/maps?q=${state.currentLocation.lat},${state.currentLocation.lng}`
      : null
  });

  // ═══════════════════════════════════════════════════════
  //  DISPATCH ALERTS — Email (send-email.js + Resend) + SMS + Live Location
  //  LangGraph Edge: EMERGENCY_PROTOCOL → dispatch_alerts
  // ═══════════════════════════════════════════════════════
  try {
    // 1. Send dedicated emergency email via send-email.js → atharvmanojshukla7@gmail.com
    const emailResult = await sendEmergencyEmail({
      trackingId: state.trackingId,
      userName: state.userName,
      userPhone: state.userPhone,
      location: state.currentLocation,
      transcript: state.threatTranscript,
      severity: state.threatSeverity,
      detectedLanguage: state.detectedLanguage || 'unknown',
      nearestStation: state.nearestPolice,
      timestamp: new Date().toISOString()
    });
    console.log(`[VoiceAgent] 📧 send-email.js result:`, emailResult.success ? '✅ SENT' : '❌ FAILED');

    // 2. Full multi-channel dispatch (email + SMS + location + dashboard)
    const dispatchResults = await dispatchFullEmergency(io, {
      trackingId: state.trackingId,
      userName: state.userName,
      userPhone: state.userPhone,
      location: state.currentLocation,
      transcript: state.threatTranscript,
      severity: state.threatSeverity,
      detectedLanguage: state.detectedLanguage || 'unknown',
      nearestStation: state.nearestPolice,
      timestamp: new Date().toISOString()
    });

    // Notify client about dispatch results
    io.to(socketId).emit('dispatch-results', {
      trackingId: state.trackingId,
      emailSent: dispatchResults.email?.success || emailResult.success || false,
      smsSent: dispatchResults.sms?.success || false,
      locationStreaming: dispatchResults.liveLocation?.success || false,
      emailMessageId: emailResult.messageId || dispatchResults.email?.messageId || null,
      detectedLanguage: state.detectedLanguage
    });

    console.log(`[VoiceAgent] ✅ All dispatch channels fired for ${state.trackingId}`);
  } catch (dispatchErr) {
    console.error(`[VoiceAgent] ❌ Dispatch failed:`, dispatchErr.message);
    // Don't block — still start recording even if dispatch fails
  }

  // LangGraph Edge: EMERGENCY_PROTOCOL → MONITORING
  // Condition: SOS email dispatched, loop back to orchestrator node
  logTransition(socketId, state.status, STATES.MONITORING, 'SOS email dispatched, loop back to orchestrator');

  setState(socketId, {
    status: STATES.MONITORING,
    threatLevel: 0,
    threatSeverity: 'Low',
    threatTranscript: null,
    interceptTimerId: null
  });

  io.to(socketId).emit('agent-state-update', {
    status: STATES.MONITORING,
    message: 'SOS Dispatch complete. Orchestrator node active and listening.',
    langGraphState: STATES.MONITORING,
    langGraphEdge: 'SOS email dispatched, loop back to orchestrator',
    detectedLanguage: state.detectedLanguage
  });
}

/**
 * LangGraph Edge: EMERGENCY_PROTOCOL → RECORDING
 * Condition: Auto-start evidence capture
 */
function startRecording(socketId, io) {
  const state = getState(socketId);

  logTransition(socketId, state.status, STATES.RECORDING, 'Evidence capture started');

  const recordingStart = Date.now();

  setState(socketId, {
    status: STATES.RECORDING,
    recordingStartTime: recordingStart
  });

  // Signal client to start recording
  io.to(socketId).emit('agent-state-update', {
    status: STATES.RECORDING,
    recordingStartTime: recordingStart,
    message: 'Recording evidence. Maximum 8 minutes.',
    langGraphState: STATES.RECORDING,
    langGraphEdge: 'Auto-start evidence capture'
  });

  io.to(socketId).emit('start-evidence-recording', {
    trackingId: state.trackingId,
    maxDuration: 8 * 60 * 1000 // 8 minutes in ms
  });

  // LangGraph Edge: RECORDING → RESOLVED
  // Condition: 8min elapsed
  const recordingTimer = setTimeout(() => {
    const currentState = getState(socketId);
    if (currentState.status === STATES.RECORDING) {
      console.log(`[VoiceAgent] 8-minute recording limit reached for ${socketId}`);
      resolveEmergency(socketId, io, 'Recording time limit reached (8 min)').catch(err => console.error('[VoiceAgent] Emergency resolution failed:', err.message));
    }
  }, 8 * 60 * 1000);

  setState(socketId, { recordingTimerId: recordingTimer });
}

/**
 * LangGraph Edge: RECORDING → RESOLVED
 * Condition: 8min elapsed OR "Safety Confirmed"
 */
async function resolveEmergency(socketId, io, reason = 'Safety confirmed by user') {
  const state = getState(socketId);

  // Clear timers
  if (state.interceptTimerId) clearTimeout(state.interceptTimerId);
  if (state.recordingTimerId) clearTimeout(state.recordingTimerId);

  logTransition(socketId, state.status, STATES.RESOLVED, reason);

  // Save emergency metadata
  const metadata = {
    trackingId: state.trackingId,
    userName: state.userName,
    userPhone: state.userPhone,
    location: state.currentLocation,
    transcript: state.threatTranscript,
    severity: state.threatSeverity,
    detectedLanguage: state.detectedLanguage,
    recordingDuration: state.recordingStartTime ? Date.now() - state.recordingStartTime : 0,
    resolvedAt: new Date().toISOString(),
    resolveReason: reason,
    stateHistory: state.stateHistory
  };

  // Wait for durable metadata persistence before announcing resolution.
  // A storage failure must be visible, but must not prevent the safety state
  // from transitioning or the client from receiving the resolution event.
  let metadataPersisted = false;
  try {
    await createMetadata(state.trackingId, metadata);
    metadataPersisted = true;
  } catch (err) {
    console.error(`[VoiceAgent] ❌ Emergency metadata persistence failed for ${state.trackingId}:`, err.message);
    io.to(socketId).emit('evidence-error', {
      success: false,
      trackingId: state.trackingId,
      error: 'Emergency metadata could not be saved to secure storage.'
    });
  }

  setState(socketId, { status: STATES.RESOLVED, metadataPersisted });

  // Notify client
  io.to(socketId).emit('agent-state-update', {
    status: STATES.RESOLVED,
    message: 'Emergency resolved. Returning to monitoring.',
    langGraphState: STATES.RESOLVED,
    langGraphEdge: reason
  });

  // Signal client to stop recording
  io.to(socketId).emit('stop-evidence-recording', {
    trackingId: state.trackingId
  });

  // Notify police dashboard
  io.emit('emergency-resolved', {
    trackingId: state.trackingId,
    resolvedAt: new Date().toISOString(),
    reason
  });

  // LangGraph Edge: RESOLVED → MONITORING
  // Condition: Agent resets, route continues
  setTimeout(() => {
    const currentState = getState(socketId);
    if (currentState.status === STATES.RESOLVED) {
      setState(socketId, {
        status: STATES.MONITORING,
        threatTranscript: null,
        threatSeverity: null,
        detectedLanguage: null,
        interceptTimerId: null,
        recordingStartTime: null,
        recordingTimerId: null,
        trackingId: null,
        nearestPolice: null
      });

      logTransition(socketId, STATES.RESOLVED, STATES.MONITORING, 'Auto-reset after resolution');

      io.to(socketId).emit('agent-state-update', {
        status: STATES.MONITORING,
        message: 'Agent reset. Monitoring resumed.',
        langGraphState: STATES.MONITORING,
        langGraphEdge: 'Agent resets, route continues'
      });
    }
  }, 2000);
}

/**
 * Cleanup when a socket disconnects
 */
function cleanupAgent(socketId) {
  const state = agentStates.get(socketId);
  if (state) {
    if (state.interceptTimerId) clearTimeout(state.interceptTimerId);
    if (state.recordingTimerId) clearTimeout(state.recordingTimerId);
    if (state._countdownInterval) clearInterval(state._countdownInterval);
    agentStates.delete(socketId);
    console.log(`[VoiceAgent] Cleaned up agent state for ${socketId}`);
  }
}

module.exports = {
  startMonitoring,
  stopMonitoring,
  processTranscript,
  cancelIntercept,
  resolveEmergency,
  cleanupAgent,
  getState,
  DISTRESS_KEYWORDS,
  detectKeywordLanguage
};
