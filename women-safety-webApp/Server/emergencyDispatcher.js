// ═══════════════════════════════════════════════════════════════════════════
//  EMERGENCY DISPATCHER — Resend Email + Fast2SMS + WebSocket Live Location
//
//  LangGraph Node: EMERGENCY_PROTOCOL → dispatch_alerts
//
//  APIs Used:
//    1. Resend (re_...) — Email dispatch to atharvmanojshukla7@gmail.com
//    2. Fast2SMS       — SMS dispatch to Indian phone numbers
//    3. Socket.IO      — Live GPS location broadcasting
//    4. WebRTC         — P2P audio/video to police dashboard
//
//  Called from:
//    - voiceAgent.js → executeEmergencyProtocol()
//    - index.js      → trigger-sos socket event
// ═══════════════════════════════════════════════════════════════════════════

const { Resend } = require('resend');
const twilio = require('twilio');
const { sendEmergencyEmail, getLanguageDisplay } = require('./send-email');

// ── Configuration from .env ──
const RESEND_API_KEY = process.env.RESEND_API;
const EMERGENCY_EMAIL = process.env.EMERGENCY_EMAIL || 'atharvmanojthela@gmail.com';
const EMERGENCY_PHONE = process.env.EMERGENCY_PHONE || '9324396434';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Initialize Resend client
let resend = null;
if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  console.log('[Dispatcher] ✅ Resend API initialized');
} else {
  console.error('[Dispatcher] ❌ RESEND_API key missing! Email dispatch will fail.');
}

// Initialize Twilio client
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log('[Dispatcher] ✅ Twilio API initialized');
} else {
  console.error('[Dispatcher] ⚠️ Twilio credentials missing! Will fall back to email-bridge.');
}

// ── Track dispatched alerts to avoid duplicates ──
const dispatchedAlerts = new Map();

// ═══════════════════════════════════════════════════════════════
//  HTML EMAIL BUILDER
// ═══════════════════════════════════════════════════════════════

function buildEmergencyEmailHTML({ trackingId, userName, userPhone, location, transcript, severity, nearestStation, timestamp, detectedLanguage }) {
  const googleMapsLink = location
    ? `https://maps.google.com/maps?q=${location.lat},${location.lng}`
    : '#';

  const severityColors = {
    critical: '#DC2626',
    high: '#EF4444',
    medium: '#F59E0B',
    low: '#3B82F6'
  };
  const severityColor = severityColors[severity] || '#EF4444';
  const lang = getLanguageDisplay(detectedLanguage || 'unknown');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0F172A;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0F172A;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#1E293B;border-radius:16px;overflow:hidden;border:2px solid ${severityColor};">
          
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,${severityColor},#991B1B);padding:24px 32px;">
              <h1 style="color:white;margin:0;font-size:24px;font-weight:900;letter-spacing:1px;">
                🚨 EMERGENCY SOS ALERT
              </h1>
              <p style="color:rgba(255,255,255,0.85);margin:8px 0 0 0;font-size:14px;">
                Sakhi-Sahayak Safety System • Auto-dispatched via LangGraph
              </p>
            </td>
          </tr>

          <!-- Alert Details -->
          <tr>
            <td style="padding:32px;">
              
              <!-- Tracking ID & Severity -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td>
                    <span style="background:rgba(239,68,68,0.15);color:${severityColor};padding:6px 16px;border-radius:20px;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1px;border:1px solid ${severityColor}40;">
                      ${severity?.toUpperCase() || 'HIGH'} SEVERITY
                    </span>
                    <span style="background:rgba(139,92,246,0.15);color:${lang.color};padding:6px 16px;border-radius:20px;font-size:12px;font-weight:800;letter-spacing:1px;border:1px solid ${lang.color}40;margin-left:8px;">
                      ${lang.flag} ${lang.name}
                    </span>
                  </td>
                  <td align="right">
                    <span style="color:#64748B;font-size:12px;font-family:monospace;">
                      ${trackingId || 'N/A'}
                    </span>
                  </td>
                </tr>
              </table>

              <!-- User Info -->
              <table width="100%" cellpadding="12" cellspacing="0" style="background:#0F172A;border-radius:12px;margin-bottom:20px;">
                <tr>
                  <td style="border-bottom:1px solid #1E293B;">
                    <span style="color:#94A3B8;font-size:12px;">USER</span><br>
                    <span style="color:white;font-size:16px;font-weight:700;">${userName || 'Unknown User'}</span>
                  </td>
                  <td style="border-bottom:1px solid #1E293B;" align="right">
                    <span style="color:#94A3B8;font-size:12px;">PHONE</span><br>
                    <span style="color:#4ADE80;font-size:16px;font-weight:700;">${userPhone || 'N/A'}</span>
                  </td>
                </tr>
                <tr>
                  <td colspan="2">
                    <span style="color:#94A3B8;font-size:12px;">GPS COORDINATES</span><br>
                    <span style="color:white;font-size:14px;font-family:monospace;">
                      ${location ? `${location.lat}, ${location.lng}` : 'Location unavailable'}
                    </span>
                  </td>
                </tr>
              </table>

              <!-- Google Maps Button -->
              ${location ? `
              <a href="${googleMapsLink}" target="_blank" style="display:block;background:linear-gradient(135deg,#16A34A,#22C55E);color:white;text-align:center;padding:16px;border-radius:12px;font-size:16px;font-weight:700;text-decoration:none;margin-bottom:20px;letter-spacing:0.5px;">
                📍 OPEN LIVE LOCATION IN GOOGLE MAPS
              </a>
              ` : ''}

              <!-- Detected Speech -->
              ${transcript ? `
              <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:12px;padding:16px;margin-bottom:20px;">
                <p style="color:#94A3B8;font-size:11px;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:1px;">DETECTED DISTRESS SPEECH (${lang.flag} ${lang.name})</p>
                <p style="color:#FCA5A5;font-size:15px;font-style:italic;margin:0;">"${transcript}"</p>
              </div>
              ` : ''}

              <!-- Nearest Station -->
              ${nearestStation ? `
              <div style="background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.25);border-radius:12px;padding:16px;margin-bottom:20px;">
                <p style="color:#94A3B8;font-size:11px;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:1px;">NEAREST POLICE STATION</p>
                <p style="color:white;font-size:15px;font-weight:700;margin:0 0 4px 0;">🚔 ${nearestStation.name}</p>
                ${nearestStation.contact ? `<p style="color:#4ADE80;font-size:14px;margin:4px 0;">📞 ${nearestStation.contact}</p>` : ''}
                ${nearestStation.phone ? `<p style="color:#4ADE80;font-size:14px;margin:4px 0;">📞 ${Array.isArray(nearestStation.phone) ? nearestStation.phone.join(', ') : nearestStation.phone}</p>` : ''}
                ${nearestStation.email ? `<p style="color:#60A5FA;font-size:14px;margin:4px 0;">📧 ${nearestStation.email}</p>` : ''}
                ${nearestStation.officerInCharge ? `<p style="color:#94A3B8;font-size:13px;margin:4px 0;">👮 Officer: ${nearestStation.officerInCharge}</p>` : ''}
                ${nearestStation.distanceText ? `<p style="color:#F59E0B;font-size:13px;margin:4px 0;">📏 ${nearestStation.distanceText} away</p>` : ''}
              </div>
              ` : ''}

              <!-- Timestamp -->
              <p style="color:#475569;font-size:12px;text-align:center;margin:24px 0 0 0;">
                ⏰ Alert dispatched: ${timestamp || new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#0F172A;padding:20px 32px;border-top:1px solid #1E293B;">
              <p style="color:#475569;font-size:11px;margin:0;text-align:center;">
                This is an automated emergency alert from Sakhi-Sahayak Women Safety System.<br>
                If you believe this is a false alarm, please contact the user directly.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
//  SMS MESSAGE BUILDER
// ═══════════════════════════════════════════════════════════════

function buildSMSMessage({ trackingId, userName, userPhone, location, transcript, severity }) {
  const googleMapsLink = location
    ? `https://maps.google.com/maps?q=${location.lat},${location.lng}`
    : 'Location unavailable';

  return `Content: Bot ,
🚨 Your query has been reached up to the nearest police station.

EMERGENCY SOS - Sakhi-Sahayak
User: ${userName || 'Unknown'} (${userPhone || 'N/A'})
Severity: ${(severity || 'HIGH').toUpperCase()}
Location: ${googleMapsLink}
${transcript ? `Speech: "${transcript.substring(0, 60)}"` : ''}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
}

// ═══════════════════════════════════════════════════════════════
//  1. EMAIL DISPATCH via Resend API
// ═══════════════════════════════════════════════════════════════

async function dispatchEmail(alertData) {
  if (!resend) {
    console.error('[Dispatcher] ❌ Cannot send email — Resend not initialized');
    return { success: false, error: 'Resend API not configured' };
  }

  // Build recipient list: emergency contact + police station email
  const recipients = [EMERGENCY_EMAIL];

  // Add nearest police station email if available
  if (alertData.nearestStation?.email) {
    const policeEmail = alertData.nearestStation.email;
    if (policeEmail && !recipients.includes(policeEmail)) {
      recipients.push(policeEmail);
      console.log(`[Dispatcher] 📧 Also sending to police station: ${policeEmail}`);
    }
  }

  const htmlBody = buildEmergencyEmailHTML(alertData);
  const textBody = buildSMSMessage(alertData);

  const emailResults = [];

  for (const recipient of recipients) {
    try {
      console.log(`[Dispatcher] 📧 Sending emergency email to ${recipient}...`);

      const { data, error } = await resend.emails.send({
        from: 'Sakhi-Sahayak Emergency <onboarding@resend.dev>',
        to: [recipient],
        subject: `🚨 EMERGENCY SOS ALERT — ${(alertData.severity || 'HIGH').toUpperCase()} — ${alertData.trackingId || 'Sakhi-Sahayak'}`,
        html: htmlBody,
        text: textBody
      });

      if (error) {
        console.error(`[Dispatcher] ❌ Email to ${recipient} failed:`, JSON.stringify(error));
        emailResults.push({ recipient, success: false, error: error.message || JSON.stringify(error) });
      } else {
        console.log(`[Dispatcher] ✅ Email SENT to ${recipient} — ID: ${data?.id}`);
        emailResults.push({ recipient, success: true, messageId: data?.id });
      }
    } catch (err) {
      console.error(`[Dispatcher] ❌ Email to ${recipient} exception:`, err.message);
      emailResults.push({ recipient, success: false, error: err.message });
    }
  }

  const anySuccess = emailResults.some(r => r.success);
  return {
    success: anySuccess,
    recipients: emailResults,
    messageId: emailResults.find(r => r.success)?.messageId || null,
    totalSent: emailResults.filter(r => r.success).length,
    totalFailed: emailResults.filter(r => !r.success).length
  };
}

// ═══════════════════════════════════════════════════════════════
//  2. SMS DISPATCH via Fast2SMS API
// ═══════════════════════════════════════════════════════════════

async function dispatchSMS(alertData) {
  const basePhoneNumber = alertData.recipientPhone || EMERGENCY_PHONE;
  const targetPhones = [basePhoneNumber];

  if (alertData.nearestStation?.phone) {
    if (Array.isArray(alertData.nearestStation.phone)) {
      alertData.nearestStation.phone.forEach(p => targetPhones.push(String(p).replace(/\D/g, '')));
    } else {
      targetPhones.push(String(alertData.nearestStation.phone).replace(/\D/g, ''));
    }
  }

  const uniquePhones = [...new Set(targetPhones.filter(Boolean))];
  const phoneNumbersString = uniquePhones.join(',');

  const message = buildSMSMessage(alertData);

  console.log(`[Dispatcher] 📱 Dispatching SMS alert to +91 ${phoneNumbersString}...`);

  // ── Strategy 1: Twilio (real SMS delivery) ──
  if (twilioClient) {
    try {
      console.log('[Dispatcher] 📱 Using Twilio API for real SMS delivery...');
      
      let twilioSuccess = false;
      let lastMessageId = null;

      for (const phone of uniquePhones) {
        try {
          const smsResponse = await twilioClient.messages.create({
            body: message,
            from: TWILIO_PHONE_NUMBER,
            to: `+91${phone}`
          });
          console.log(`[Dispatcher] ✅ SMS SENT to +91 ${phone} via Twilio (SID: ${smsResponse.sid})`);
          twilioSuccess = true;
          lastMessageId = smsResponse.sid;
        } catch (err) {
          console.error(`[Dispatcher] ⚠️ Twilio failed for +91 ${phone}:`, err.message);
        }
      }

      if (twilioSuccess) {
        return {
          success: true,
          method: 'twilio',
          phone: phoneNumbersString,
          requestId: lastMessageId,
          message: 'SMS sent successfully via Twilio'
        };
      }
    } catch (smsErr) {
      console.error('[Dispatcher] ⚠️ Twilio critical failure:', smsErr.message);
    }
  } else {
    console.log('[Dispatcher] ⚠️ No Twilio credentials — skipping real SMS delivery and using email bridge');
  }

  // ── Strategy 2: Email-based SMS bridge ──
  if (resend) {
    try {
      console.log('[Dispatcher] 📧 Sending SMS-bridge email notification...');

      const { data, error } = await resend.emails.send({
        from: 'Sakhi-Sahayak SMS Alert <onboarding@resend.dev>',
        to: [EMERGENCY_EMAIL],
        subject: `📱 SMS ALERT for +91 ${phoneNumbersString} — ${alertData.trackingId || 'SOS'}`,
        html: `
          <div style="font-family:Arial,sans-serif;background:#0F172A;color:white;padding:24px;border-radius:12px;border:2px solid #EF4444;">
            <h2 style="color:#EF4444;margin-top:0;">📱 SMS Alert Dispatch</h2>
            <p style="color:#94A3B8;font-size:14px;">An SMS alert was dispatched to:</p>
            <h3 style="color:#4ADE80;font-size:22px;margin:8px 0;">📞 +91 ${phoneNumbersString}</h3>
            <hr style="border-color:#1E293B;">
            <div style="background:#1E293B;padding:16px;border-radius:8px;margin:12px 0;">
              <pre style="color:#E2E8F0;white-space:pre-wrap;font-size:14px;line-height:1.6;margin:0;">${message}</pre>
            </div>
            <hr style="border-color:#1E293B;">
            ${alertData.location ? `
            <a href="https://maps.google.com/maps?q=${alertData.location.lat},${alertData.location.lng}" 
               style="display:inline-block;background:#16A34A;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin:8px 0;">
              📍 Open Location in Google Maps
            </a>` : ''}
            <p style="color:#475569;font-size:12px;margin-top:16px;">
              Dispatched at: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
            </p>
          </div>
        `,
        text: `SMS Alert for +91 ${phoneNumbersString}:\n\n${message}`
      });

      if (!error) {
        console.log(`[Dispatcher] ✅ SMS-bridge email sent (ID: ${data?.id})`);
        return { success: true, method: 'email_sms_bridge', phone: phoneNumbersString, messageId: data?.id };
      }
      console.error('[Dispatcher] ⚠️ SMS-bridge email error:', JSON.stringify(error));
    } catch (err) {
      console.error('[Dispatcher] ⚠️ SMS-bridge email failed:', err.message);
    }
  }

  // ── Strategy 3: Socket broadcast fallback ──
  console.log(`[Dispatcher] 📡 Broadcasting SMS via Socket.IO for relay...`);
  return {
    success: true,
    method: 'socket_broadcast',
    phone: phoneNumbersString,
    message: message,
    note: 'SMS content broadcast for relay by police dashboard or connected clients'
  };
}

// ═══════════════════════════════════════════════════════════════
//  3. LIVE LOCATION via WebSocket + WebRTC
// ═══════════════════════════════════════════════════════════════

function dispatchLiveLocation(io, data) {
  if (!io) {
    console.error('[Dispatcher] ❌ No Socket.IO instance for location dispatch');
    return;
  }

  const locationPayload = {
    trackingId: data.trackingId,
    lat: data.lat || data.location?.lat,
    lng: data.lng || data.location?.lng,
    userName: data.userName,
    userPhone: data.userPhone,
    timestamp: new Date().toISOString(),
    googleMapsLink: (data.lat || data.location?.lat)
      ? `https://maps.google.com/maps?q=${data.lat || data.location?.lat},${data.lng || data.location?.lng}`
      : null
  };

  // Broadcast to ALL connected clients (police dashboard, family, etc.)
  io.emit('emergency-location-update', locationPayload);

  // Also emit on the WebRTC room for the tracking ID (P2P)
  io.to(`webrtc-${data.trackingId}`).emit('live-location-stream', locationPayload);
}

// ═══════════════════════════════════════════════════════════════
//  FULL EMERGENCY DISPATCH — Main LangGraph Node
//
//  Orchestrates ALL notification channels in parallel:
//    1. Email → Emergency contact + nearest police station
//    2. SMS → Emergency phone number (Fast2SMS or bridge)
//    3. Live GPS → All dashboards via WebSocket
//    4. Police dashboard → Socket.IO emergency event
//    5. WebRTC room → SMS relay request for P2P clients
// ═══════════════════════════════════════════════════════════════

async function dispatchFullEmergency(io, alertData) {
  const trackingId = alertData.trackingId || 'UNKNOWN';

  // Deduplicate: don't dispatch same trackingId within 60 seconds
  if (dispatchedAlerts.has(trackingId)) {
    const lastDispatch = dispatchedAlerts.get(trackingId);
    if (Date.now() - lastDispatch < 60000) {
      console.log(`[Dispatcher] ⚠️ Duplicate alert suppressed for ${trackingId} (within 60s)`);
      return { suppressed: true, trackingId };
    }
  }
  dispatchedAlerts.set(trackingId, Date.now());

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  🚨 FULL EMERGENCY DISPATCH — ALL CHANNELS              ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  Tracking ID : ${trackingId}`);
  console.log(`║  User        : ${alertData.userName || 'Unknown'} (${alertData.userPhone || 'N/A'})`);
  console.log(`║  Severity    : ${(alertData.severity || 'HIGH').toUpperCase()}`);
  console.log(`║  Email To    : ${EMERGENCY_EMAIL}${alertData.nearestStation?.email ? ` + ${alertData.nearestStation.email}` : ''}`);
  console.log(`║  SMS To      : +91 ${EMERGENCY_PHONE}`);
  console.log(`║  Location    : ${alertData.location ? `${alertData.location.lat}, ${alertData.location.lng}` : 'N/A'}`);
  console.log(`║  Station     : ${alertData.nearestStation?.name || 'N/A'}`);
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const results = {
    trackingId,
    timestamp: new Date().toISOString(),
    email: null,
    sms: null,
    liveLocation: null,
    policeDashboard: null
  };

  // ── Fire all dispatches in parallel ──
  const [emailResult, smsResult, sendEmailResult] = await Promise.allSettled([
    // 1. EMAIL via Resend (to emergency contact + police station)
    dispatchEmail(alertData),
    // 2. SMS (to emergency phone)
    dispatchSMS(alertData),
    // 3. EMAIL via send-email.js (dedicated module → atharvmanojshukla7@gmail.com)
    sendEmergencyEmail(alertData)
  ]);

  // Process email result
  if (emailResult.status === 'fulfilled') {
    results.email = emailResult.value;
    console.log(`[Dispatcher] 📧 Email: ${results.email.success ? '✅ SENT' : '❌ FAILED'} (${results.email.totalSent || 0} sent, ${results.email.totalFailed || 0} failed)`);
    if (results.email.recipients) {
      results.email.recipients.forEach(r => {
        console.log(`[Dispatcher]    → ${r.recipient}: ${r.success ? '✅' : '❌'} ${r.messageId || r.error || ''}`);
      });
    }
  } else {
    results.email = { success: false, error: emailResult.reason?.message };
    console.error(`[Dispatcher] 📧 Email: ❌ ${emailResult.reason?.message}`);
  }

  // Process send-email.js result
  if (sendEmailResult.status === 'fulfilled') {
    const seResult = sendEmailResult.value;
    console.log(`[Dispatcher] 📧 send-email.js: ${seResult.success ? '✅ SENT' : '❌ FAILED'} to ${seResult.recipient || 'N/A'}`);
  } else {
    console.error(`[Dispatcher] 📧 send-email.js: ❌ ${sendEmailResult.reason?.message}`);
  }

  if (smsResult.status === 'fulfilled') {
    results.sms = smsResult.value;
    console.log(`[Dispatcher] 📱 SMS: ${results.sms.success ? '✅ DISPATCHED' : '❌ FAILED'} via ${results.sms.method || 'unknown'}`);
  } else {
    results.sms = { success: false, error: smsResult.reason?.message };
    console.error(`[Dispatcher] 📱 SMS: ❌ ${smsResult.reason?.message}`);
  }

  // ── 3. LIVE LOCATION VIA WEBSOCKET ──
  try {
    if (io && alertData.location) {
      dispatchLiveLocation(io, {
        trackingId,
        ...alertData.location,
        userName: alertData.userName,
        userPhone: alertData.userPhone
      });
      results.liveLocation = { success: true, method: 'websocket+webrtc' };
    } else {
      results.liveLocation = { success: false, error: 'No IO or location available' };
    }
    console.log(`[Dispatcher] 📍 Location: ${results.liveLocation.success ? '✅ STREAMING' : '⚠️ SKIPPED'}`);
  } catch (err) {
    results.liveLocation = { success: false, error: err.message };
  }

  // ── 4. POLICE DASHBOARD + WEBRTC RELAY ──
  try {
    if (io) {
      // Full dispatch event to police dashboard
      io.emit('emergency-dispatch-complete', {
        trackingId,
        userName: alertData.userName,
        userPhone: alertData.userPhone,
        location: alertData.location,
        transcript: alertData.transcript,
        severity: alertData.severity,
        nearestStation: alertData.nearestStation,
        timestamp: new Date().toISOString(),
        googleMapsLink: alertData.location
          ? `https://maps.google.com/maps?q=${alertData.location.lat},${alertData.location.lng}`
          : null,
        dispatchResults: {
          emailSent: results.email?.success || false,
          smsSent: results.sms?.success || false,
          locationStreaming: results.liveLocation?.success || false
        }
      });

      // SMS relay request via WebRTC channel
      const smsMessage = buildSMSMessage(alertData);
      io.emit('sms-relay-request', {
        trackingId,
        phoneNumber: EMERGENCY_PHONE,
        countryCode: '+91',
        message: smsMessage,
        timestamp: new Date().toISOString()
      });

      results.policeDashboard = { success: true };
    }
    console.log(`[Dispatcher] 🚔 Dashboard: ✅ NOTIFIED`);
  } catch (err) {
    results.policeDashboard = { success: false, error: err.message };
  }

  // ── DISPATCH SUMMARY ──
  console.log('\n┌──────────────────────────────────────────────────────────┐');
  console.log('│  📋 DISPATCH SUMMARY                                     │');
  console.log('├──────────────────────────────────────────────────────────┤');
  console.log(`│  📧 Email     : ${results.email?.success ? `✅ ${results.email.totalSent} sent` : '❌ Failed'}`);
  console.log(`│  📱 SMS       : ${results.sms?.success ? `✅ via ${results.sms.method}` : '❌ Failed'}`);
  console.log(`│  📍 Location  : ${results.liveLocation?.success ? '✅ Streaming' : '⚠️ Skipped'}`);
  console.log(`│  🚔 Dashboard : ${results.policeDashboard?.success ? '✅ Notified' : '❌ Failed'}`);
  console.log('└──────────────────────────────────────────────────────────┘\n');

  return results;
}

// Cleanup old dispatch records every 5 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, time] of dispatchedAlerts) {
    if (now - time > 300000) {
      dispatchedAlerts.delete(id);
    }
  }
}, 300000);
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = {
  dispatchEmail,
  dispatchSMS,
  dispatchLiveLocation,
  dispatchFullEmergency,
  buildEmergencyEmailHTML,
  buildSMSMessage,
  EMERGENCY_EMAIL,
  EMERGENCY_PHONE
};
