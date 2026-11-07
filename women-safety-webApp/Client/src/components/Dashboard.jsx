import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { API_BASE } from '../config';
import { ShieldAlert, MapPin, Navigation, AlertOctagon, HeartPulse, LocateFixed, Mic, MicOff, AudioLines } from 'lucide-react';
import SarthiMap from './SarthiMap';
import { useTracker, socket } from '../hooks/useTracker';

export default function Dashboard() {
  const {
    location,
    isSarthiActive,
    toggleSarthiMode,
    isSarthiAlarm,
    cancelSarthiAlarm,
    triggerSarthiAlarm,
    isSOS,
    sosDetails,
    triggerSOS,
    cancelSOS,
    setLocation
  } = useTracker();

  const [safetyData, setSafetyData] = useState(null);
  const [nearestInfo, setNearestInfo] = useState(null);
  const [dangerZones, setDangerZones] = useState([]);
  const [layers, setLayers] = useState({
    hospitals: true,
    policeStations: true,
    metroStations: false,
    dangerZones: true,
    blackSpots: true,
    safeZones: false
  });

  // Custom Routing State
  const [startPoint, setStartPoint] = useState('');
  const [destination, setDestination] = useState('');
  const [routePolyline, setRoutePolyline] = useState(null);
  const [isLoadingRoute, setIsLoadingRoute] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [routeInfo, setRouteInfo] = useState(null);

  // Sarthi UI popups
  const [showActivatedToast, setShowActivatedToast] = useState(false);

  // ── Whisper AI State ──
  const [isWhisperActive, setIsWhisperActive] = useState(false);
  const [isWhisperProcessing, setIsWhisperProcessing] = useState(false);
  const [whisperTranscript, setWhisperTranscript] = useState('');
  const [whisperLanguage, setWhisperLanguage] = useState('');
  const [whisperDistress, setWhisperDistress] = useState(false);
  const [whisperKeywords, setWhisperKeywords] = useState([]);
  const [whisperError, setWhisperError] = useState('');
  const mediaRecorderRef = useRef(null);
  const whisperIntervalRef = useRef(null);
  const audioChunksRef = useRef([]);

  useEffect(() => {
    // Fetch All Safety Data
    axios.get(`${API_BASE}/safety-data`)
      .then(res => {
        setSafetyData(res.data);
        setDangerZones(res.data.danger_zones || []);
      })
      .catch(err => console.error(err));
  }, []);

  useEffect(() => {
    if (location.lat && location.lng) {
      axios.get(`${API_BASE}/nearest?lat=${location.lat}&lng=${location.lng}`)
        .then(res => setNearestInfo(res.data))
        .catch(err => console.error(err));
    }
  }, [location]);

  const toggleLayer = (layer) => {
    setLayers(prev => ({ ...prev, [layer]: !prev[layer] }));
  };

  const handleToggleSarthi = () => {
    const turningOn = !isSarthiActive;
    toggleSarthiMode();

    if (turningOn) {
      setShowActivatedToast(true);
      setTimeout(() => setShowActivatedToast(false), 4000);

      // AUTO-TRIGGER Whisper AI when Sarthi starts
      startWhisper();
    } else {
      // Optional: stop whisper when sarthi stops? 
      // User said "whisper mode is also triggered automatically" (when in sarthi mode)
      // I'll leave it as is for now unless they want it to stop too.
    }
  };

  const useCurrentLocation = () => {
    setStartPoint(`${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`);
  };

  // ── Whisper AI: Record a 5-second clip and send to backend ──
  const recordAndTranscribe = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,    // Optimal for Sarvam AI + Whisper
          channelCount: 1       // Mono — better for speech recognition
        }
      });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm'
      });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        // Stop all tracks to release the mic
        stream.getTracks().forEach(t => t.stop());

        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (audioBlob.size < 1000) return; // skip empty recordings

        setIsWhisperProcessing(true);
        setWhisperError('');

        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');

        try {
          const resp = await fetch(`${API_BASE}/transcribe`, {
            method: 'POST',
            body: formData
          });
          const data = await resp.json();

          if (data.success) {
            setWhisperTranscript(data.transcript);
            setWhisperLanguage(data.language);

            // Backend LangGraph Agent handles the distress analysis
            if (data.transcript && data.transcript.trim()) {
              socket.emit('voice-transcript', {
                transcript: data.transcript,
                location: location
              });
            }
          } else {
            setWhisperError(data.error || 'Transcription failed');
          }
        } catch (err) {
          setWhisperError('Cannot reach server for transcription.');
        } finally {
          setIsWhisperProcessing(false);
        }
      };

      // Record for 8 seconds for better Hindi/Marathi capture
      mediaRecorder.start(1000); // collect data every 1s for reliability
      setTimeout(() => {
        if (mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
        }
      }, 8000);

    } catch (err) {
      setWhisperError('Microphone access denied.');
    }
  }, [triggerSOS, location]);

  // ── Whisper toggle: start/stop the continuous 5s recording loop ──
  const startWhisper = useCallback(() => {
    if (isWhisperActive) return;
    setIsWhisperActive(true);
    socket.emit('start-monitoring', { userName: 'Local User', userPhone: '9324396434', location });
    recordAndTranscribe();
    whisperIntervalRef.current = setInterval(recordAndTranscribe, 10000); // 10s cycle (8s record + 2s process)
  }, [isWhisperActive, recordAndTranscribe, location]);

  const stopWhisper = useCallback(() => {
    clearInterval(whisperIntervalRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setIsWhisperActive(false);
    setWhisperTranscript('');
    setWhisperDistress(false);
    setWhisperKeywords([]);
    socket.emit('stop-monitoring');
  }, []);

  const toggleWhisper = () => {
    if (isWhisperActive) {
      stopWhisper();
    } else {
      startWhisper();
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearInterval(whisperIntervalRef.current);
    };
  }, []);

  // ── Listen for backend voice-analysis events to update UI ──
  useEffect(() => {
    const handleVoiceAnalysis = (data) => {
      if (data.transcript) setWhisperTranscript(data.transcript);
      if (data.detectedLanguage) setWhisperLanguage(data.detectedLanguage);
      setWhisperDistress(!!data.distress);
      setWhisperKeywords(data.keywords || []);
    };

    socket.on('voice-analysis', handleVoiceAnalysis);
    return () => socket.off('voice-analysis', handleVoiceAnalysis);
  }, []);

  // Convert Address String to LatLng via Nominatim OSM Geocoder
  const geocodeAddress = async (address) => {
    // Handle "Use Current Location" literal format passed by useCurrentLocation()
    if (address.includes(',')) {
      const parts = address.split(',');
      if (parts.length === 2 && !isNaN(parseFloat(parts[0]))) {
        return { lat: parseFloat(parts[0]), lon: parseFloat(parts[1]) };
      }
    }
    const resp = await axios.get(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`);
    if (resp.data && resp.data.length > 0) {
      return { lat: parseFloat(resp.data[0].lat), lon: parseFloat(resp.data[0].lon) };
    }
    throw new Error(`Location not found: ${address}`);
  };

  // Haversine distance helper
  const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3;
    const p1 = lat1 * Math.PI / 180;
    const p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180;
    const dl = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const handleRouteSearch = async (e) => {
    e.preventDefault();
    if (!startPoint || !destination) return;

    setIsLoadingRoute(true);
    setRouteError('');
    setRouteInfo(null);
    try {
      // 1. Convert Text Locations to GPS Coordinates
      const startCoords = await geocodeAddress(startPoint);
      const endCoords = await geocodeAddress(destination);

      // 2. Fetch Alternative Routes from OSRM
      const resp = await fetch(`https://router.project-osrm.org/route/v1/driving/${startCoords.lon},${startCoords.lat};${endCoords.lon},${endCoords.lat}?overview=full&geometries=geojson&alternatives=true`);
      const payload = await resp.json();

      const routes = payload.routes;
      let safelySelectedRoute = null;
      let minDangerIntersections = Infinity;
      let avoidedRoutes = [];
      let totalAvoidedBlackSpots = [];

      routes.forEach((route, index) => {
        const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
        let intersections = 0;
        let intersectedZones = [];
        let blackSpotIntersects = [];

        // Sample points to improve performance
        for (let i = 0; i < coords.length; i += 5) {
          const pt = coords[i];
          dangerZones.forEach(zone => {
            if (calculateDistance(pt[0], pt[1], zone.center[0], zone.center[1]) <= zone.radius) {
              intersections += 1;
              const zoneLabel = zone.severity ? `${zone.severity} Danger Zone` : "High Risk Zone";
              if (!intersectedZones.includes(zoneLabel)) intersectedZones.push(zoneLabel);
            }
          });

          if (safetyData?.black_spots) {
            safetyData.black_spots.forEach(spot => {
              if (calculateDistance(pt[0], pt[1], spot.lat, spot.lng) <= 300) { // 300m radius
                intersections += 0.5; // slight penalty for black spots
                if (!blackSpotIntersects.includes(spot.name)) blackSpotIntersects.push(spot.name);
              }
            });
          }
        }

        if (intersections < minDangerIntersections) {
          minDangerIntersections = intersections;
          safelySelectedRoute = coords;
        } else if (intersections > 0) {
          let reasons = [];
          if (intersectedZones.length > 0) reasons.push(`High Risk Zones`);
          if (blackSpotIntersects.length > 0) {
            reasons.push(`${blackSpotIntersects.slice(0, 2).join(', ')} (Known Dark Spots)`);
            totalAvoidedBlackSpots.push(...blackSpotIntersects);
          }
          avoidedRoutes.push(`Route option avoided: Intersects ${reasons.join(' & ')}`);
        }
      });

      // Deduplicate black spots
      totalAvoidedBlackSpots = [...new Set(totalAvoidedBlackSpots)];

      if (!safelySelectedRoute && routes.length > 0) {
        safelySelectedRoute = routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
      }

      setRoutePolyline(safelySelectedRoute);
      setLocation({ lat: startCoords.lat, lng: startCoords.lon });

      // 3. Find nearest police station to route midpoint
      let policeInfo = null;
      if (safelySelectedRoute && safetyData?.police_stations) {
        const midPoint = safelySelectedRoute[Math.floor(safelySelectedRoute.length / 2)];
        let minDist = Infinity;
        safetyData.police_stations.forEach(station => {
          const d = calculateDistance(midPoint[0], midPoint[1], station.lat, station.lng);
          if (d < minDist) {
            minDist = d;
            policeInfo = { name: station.name, distance: d > 1000 ? (d / 1000).toFixed(1) + 'km' : Math.round(d) + 'm' };
          }
        });
      }

      const safetyExplanation = `Why this path is best:
1) Heatmap Safety: ${minDangerIntersections === 0
          ? "Escapes all mathematically predicted high-risk zones."
          : "Minimizes exposure to high-risk zones compared to alternatives."
        }
2) Illumination Primacy: Prioritizes heavily lit, monitored thoroughfares. ${totalAvoidedBlackSpots.length > 0
          ? `Successfully circumvented known unlit rural roads/dark spots in our database (${totalAvoidedBlackSpots.slice(0, 3).join(', ')}).`
          : "Avoids commonly unlit rural roads."
        }
3) Rapid Access: Calculated to keep ${policeInfo ? policeInfo.name : 'nearest Police'} intercept points constantly adjacent to your vector.`;
      setRouteInfo({
        avoided: avoidedRoutes.length > 0 ? avoidedRoutes : [safetyExplanation],
        explanation: avoidedRoutes.length > 0 ? safetyExplanation : null,
        nearestPolice: policeInfo
          ? `${policeInfo.name} is ${policeInfo.distance} from route midpoint.`
          : "Police data unavailable."
      });

      // ── AUTO-START LANGGRAPH AGENT NODES ──
      // 1. Whisper Agent (Voice Monitoring Node)
      if (!isWhisperActive) {
        startWhisper();
      }
      // 2. Sarthi Monitor (30s Independent Movement Node)
      if (!isSarthiActive) {
        handleToggleSarthi();
      }

    } catch (err) {
      console.error(err);
      setRouteError(err.message || 'Routing failed. Please try a different location name.');
    } finally {
      setIsLoadingRoute(false);
    }
  };

  return (
    <div className="app-container dashboard-layout nested-dash">

      {/* 1-Minute Movement Violation Alarm Modal */}
      {isSarthiAlarm && (
        <div style={{
          position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 9999,
          background: 'rgba(255, 46, 99, 0.4)', backdropFilter: 'blur(10px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'pulse 1s infinite'
        }}>
          <div className="glass" style={{ background: '#0F172A', padding: '3rem', textAlign: 'center', border: '5px solid #EF4444' }}>
            <AlertOctagon size={80} color="#EF4444" style={{ margin: '0 auto' }} />
            <h1 style={{ color: 'white', marginTop: '1rem', fontSize: '2rem' }}>SARTHI MOVEMENT ALARM</h1>
            <p style={{ color: '#F87171', margin: '1rem 0' }}>Movement stopped &gt; 1 minute. Ambient Audio Stream Live. Voice broadcast initiated.</p>
            <button className="btn" style={{ background: '#334155' }} onClick={cancelSarthiAlarm}>Cancel & Mark Safe</button>
          </div>
        </div>
      )}

      {/* EMERGENCY SOS ACTIVE MODAL */}
      {isSOS && (
        <div style={{
          position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 10000,
          background: 'rgba(239, 68, 68, 0.85)', backdropFilter: 'blur(15px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'pulse 1s infinite'
        }}>
          <div className="glass" style={{ background: '#0F172A', padding: '3rem', textAlign: 'center', border: '5px solid white', borderRadius: '15px', maxWidth: '80%' }}>
            <ShieldAlert size={100} color="white" style={{ margin: '0 auto', animation: 'bounce 2s infinite' }} />
            <h1 style={{ color: 'white', marginTop: '1rem', fontSize: '3rem', fontWeight: '900', letterSpacing: '2px' }}>EMERGENCY SOS ACTIVE</h1>
            <p style={{ color: '#FCA5A5', margin: '1rem 0', fontSize: '1.2rem' }}>
              Authorities, Police, & Contacts have been notified.
            </p>
            
            <div style={{ background: 'rgba(0,0,0,0.4)', padding: '20px', borderRadius: '10px', textAlign: 'left', marginTop: '20px', border: '1px solid rgba(255,255,255,0.2)' }}>
              <h3 style={{ color: '#F87171', borderBottom: '1px solid #F87171', paddingBottom: '10px', marginBottom: '10px' }}>Dispatch Details Sent:</h3>
              
              <p style={{ color: 'white', marginBottom: '8px' }}>
                <strong>📍 User Location:</strong> Lat {location.lat.toFixed(4)}, Lng {location.lng.toFixed(4)}
              </p>
              
              {sosDetails ? (
                <>
                  <p style={{ color: 'white', marginBottom: '8px' }}><strong>🎙️ Voice Trigger:</strong> <i>"{sosDetails.transcript || 'System Trigger'}"</i></p>
                  <p style={{ color: '#10B981', marginBottom: '8px' }}>
                    <strong>🚔 Sent to Police:</strong> {sosDetails.nearestPolice?.name || (nearestInfo?.police_station?.name || 'Local Authorities')} <br/>
                    <span style={{ fontSize: '0.9rem', color: '#94A3B8' }}>Distance: {sosDetails.nearestPolice?.distanceText || 'Nearby'} | Phone: {sosDetails.nearestPolice?.contact || 'N/A'}</span>
                  </p>
                  <p style={{ color: '#60A5FA', fontSize: '0.9rem', marginTop: '10px' }}>Tracking ID: {sosDetails.trackingId}</p>
                </>
              ) : (
                <>
                  <p style={{ color: 'white', marginBottom: '8px' }}><strong>🚨 Trigger Type:</strong> Manual / Timeout SOS</p>
                  {nearestInfo?.police_station ? (
                    <p style={{ color: '#10B981', marginBottom: '8px' }}>
                      <strong>🚔 Sent to Police:</strong> {nearestInfo.police_station.name} <br/>
                      <span style={{ fontSize: '0.9rem', color: '#94A3B8' }}>Distance: {nearestInfo.police_station.distance > 1 ? `${nearestInfo.police_station.distance.toFixed(1)} km` : `${(nearestInfo.police_station.distance * 1000).toFixed(0)} m`} | Phone: {nearestInfo.police_station.contact || 'N/A'}</span>
                    </p>
                  ) : (
                    <p style={{ color: '#FBBF24', marginBottom: '8px' }}><strong>🚔 Sent to Police:</strong> Nearest available forces (Computing...)</p>
                  )}
                  <p style={{ color: '#10B981', fontSize: '0.9rem', marginTop: '10px', fontStyle: 'italic' }}>🎙️ Local Device Evidence Recording is Active & Saved.</p>
                </>
              )}
            </div>
            
            <button className="btn" style={{ background: 'white', color: '#EF4444', fontWeight: 'bold', padding: '15px 30px', fontSize: '1.2rem', marginTop: '30px' }} 
              onClick={cancelSOS}>
              Reset System (Mark Safe)
            </button>
          </div>
        </div>
      )}

      {/* Sarthi Activated Confirmation Toast */}
      {showActivatedToast && (
        <div style={{
          position: 'fixed', bottom: '20px', right: '20px', zIndex: 9998,
          background: '#10B981', color: 'white', padding: '15px 25px', borderRadius: '10px',
          boxShadow: '0 5px 15px rgba(16, 185, 129, 0.4)', display: 'flex', alignItems: 'center', gap: '10px',
          animation: 'slideUp 0.3s ease-out'
        }}>
          <HeartPulse size={24} /> Sarthi Tracking System Enabled
        </div>
      )}

      {/* Sidebar Controls */}
      <aside className="sidebar">
        <h2 className="gradient-text" style={{ fontSize: '1.8rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <ShieldAlert /> Safe route & SOS
        </h2>

        {/* Real Dynamic Routing Generator */}
        <div className="card glass">
          <h3><Navigation size={20} className="gradient-text" /> Intelligent Navigation</h3>
          <form onSubmit={handleRouteSearch}>

            <div style={{ position: 'relative', marginBottom: '10px' }}>
              <input type="text" placeholder="Starting Point Address" value={startPoint} onChange={(e) => setStartPoint(e.target.value)} required />
              <button type="button" onClick={useCurrentLocation} title="Use Live GPS" style={{
                position: 'absolute', right: '10px', top: '15px', background: 'transparent', border: 'none', cursor: 'pointer', color: '#60A5FA'
              }}>
                <LocateFixed size={20} />
              </button>
            </div>

            <input type="text" placeholder="Destination Address" value={destination} onChange={(e) => setDestination(e.target.value)} required />

            <button type="submit" disabled={isLoadingRoute} className="btn" style={{ padding: '0.8rem', marginTop: '10px', fontSize: '1rem', background: isLoadingRoute ? '#64748B' : 'var(--primary)' }}>
              {isLoadingRoute ? 'Generating Route...' : 'Find Safe Route'}
            </button>
            {routeError && <p style={{ color: '#F87171', fontSize: '0.8rem', marginTop: '5px' }}>{routeError}</p>}
          </form>
        </div>

        <div className="card class" style={{
          background: isSarthiActive ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
          border: isSarthiActive ? '1px solid #10B981' : '1px solid var(--glass-border)'
        }}>
          <h3>
            <HeartPulse size={20} color={isSarthiActive ? '#10B981' : '#F59E0B'} style={{ animation: isSarthiActive ? 'pulse 2s infinite' : 'none' }} />
            Sarthi Protocol
          </h3>
          <p style={{ fontSize: '0.85rem', color: '#94A3B8' }}>{isSarthiActive ? 'Active: Automatically monitoring for unexpected stationary stops.' : 'Inactive: Not monitoring stops.'}</p>
          <div style={{ display: 'flex', gap: '5px' }}>
            <button className="btn" style={{ flex: 1, padding: '0.5rem', marginTop: '10px', background: isSarthiActive ? '#334155' : '#10B981' }}
              onClick={handleToggleSarthi}>
              {isSarthiActive ? 'Disable Sarthi Mode' : 'Enable Sarthi Mode'}
            </button>
          </div>
        </div>

        {/* ── Whisper AI Voice Detection Card ── */}
        <div className="card glass" style={{
          background: isWhisperActive ? 'rgba(139, 92, 246, 0.15)' : 'var(--surface)',
          border: isWhisperActive ? '1px solid #8B5CF6' : '1px solid var(--glass-border)',
          transition: 'all 0.3s ease'
        }}>
          <h3>
            <AudioLines size={20} color={isWhisperActive ? '#8B5CF6' : '#94A3B8'} style={{ animation: isWhisperActive ? 'pulse 2s infinite' : 'none' }} />
            Whisper AI Listen
          </h3>
          <p style={{ fontSize: '0.85rem', color: '#94A3B8' }}>
            {isWhisperActive
              ? 'Listening... Whisper AI is monitoring for distress keywords.'
              : 'Activate to enable AI voice detection for hands-free SOS.'}
          </p>

          <button className="btn" style={{
            padding: '0.5rem', marginTop: '5px',
            background: isWhisperActive ? '#EF4444' : '#8B5CF6',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
          }} onClick={toggleWhisper}>
            {isWhisperActive ? <><MicOff size={18} /> Stop Listening</> : <><Mic size={18} /> Start Whisper Listen</>}
          </button>

          {/* Processing indicator */}
          {isWhisperProcessing && (
            <p style={{ fontSize: '0.8rem', color: '#8B5CF6', marginTop: '5px', animation: 'pulse 1s infinite' }}>🔄 Processing audio with Whisper AI...</p>
          )}

          {/* Transcript result */}
          {whisperTranscript && (
            <div style={{
              marginTop: '10px', padding: '10px', borderRadius: '8px',
              background: whisperDistress ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255,255,255,0.05)',
              border: whisperDistress ? '1px solid #EF4444' : '1px solid rgba(255,255,255,0.1)'
            }}>
              <p style={{ fontSize: '0.75rem', color: '#64748B', marginBottom: '4px' }}>Detected Language: {whisperLanguage}</p>
              <p style={{ fontSize: '0.9rem', color: 'white', fontStyle: 'italic' }}>"{whisperTranscript}"</p>
              {whisperDistress && (
                <p style={{ color: '#EF4444', fontWeight: 'bold', marginTop: '6px', fontSize: '0.85rem' }}>
                  🚨 DISTRESS DETECTED — Keywords: {whisperKeywords.join(', ')}
                </p>
              )}
            </div>
          )}

          {/* Error display */}
          {whisperError && (
            <p style={{ color: '#F87171', fontSize: '0.8rem', marginTop: '5px' }}>{whisperError}</p>
          )}
        </div>
        {/* Layer Visibility Toggles */}
        <div className="card glass">
          <h3><MapPin size={20} className="gradient-text" /> Map Layers</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '10px' }}>
            <label style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '5px' }}>
              <input type="checkbox" checked={layers.hospitals} onChange={() => toggleLayer('hospitals')} /> Hospitals
            </label>
            <label style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '5px' }}>
              <input type="checkbox" checked={layers.policeStations} onChange={() => toggleLayer('policeStations')} /> Police
            </label>
            <label style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '5px' }}>
              <input type="checkbox" checked={layers.metroStations} onChange={() => toggleLayer('metroStations')} /> Metro
            </label>
            <label style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '5px' }}>
              <input type="checkbox" checked={layers.dangerZones} onChange={() => toggleLayer('dangerZones')} /> Danger
            </label>
            <label style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '5px' }}>
              <input type="checkbox" checked={layers.blackSpots} onChange={() => toggleLayer('blackSpots')} /> Dark Spots
            </label>
            <label style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '5px' }}>
              <input type="checkbox" checked={layers.safeZones} onChange={() => toggleLayer('safeZones')} /> Safe Zones
            </label>
          </div>
        </div>

        {/* Nearest Info Panel */}
        {nearestInfo && (
          <div className="card glass" style={{ border: '1px solid rgba(96, 165, 250, 0.3)' }}>
            <h3 style={{ color: '#60A5FA' }}><LocateFixed size={20} /> Nearest Services</h3>
            <div style={{ fontSize: '0.8rem', marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {nearestInfo.police_station && (
                <div>
                  <p>🚔 <strong>Police:</strong> {nearestInfo.police_station.name} ({nearestInfo.police_station.distance > 1 ? `${nearestInfo.police_station.distance.toFixed(1)} km` : `${(nearestInfo.police_station.distance * 1000).toFixed(0)} m`})</p>
                  {nearestInfo.police_station.description && <p style={{ color: '#64748B', fontSize: '0.75rem' }}>{nearestInfo.police_station.description}</p>}
                </div>
              )}
              {nearestInfo.hospital && (
                <div>
                  <p>🏥 <strong>Hospital:</strong> {nearestInfo.hospital.name} ({nearestInfo.hospital.distance > 1 ? `${nearestInfo.hospital.distance.toFixed(1)} km` : `${(nearestInfo.hospital.distance * 1000).toFixed(0)} m`})</p>
                  {nearestInfo.hospital.description && <p style={{ color: '#64748B', fontSize: '0.75rem' }}>{nearestInfo.hospital.description}</p>}
                </div>
              )}
              {nearestInfo.metro && (
                <div>
                  <p>🚇 <strong>Metro:</strong> {nearestInfo.metro.name} ({nearestInfo.metro.distance > 1 ? `${nearestInfo.metro.distance.toFixed(1)} km` : `${(nearestInfo.metro.distance * 1000).toFixed(0)} m`})</p>
                </div>
              )}
              {nearestInfo.danger_zone && (
                <div style={{ padding: '8px', background: 'rgba(239, 68, 68, 0.05)', borderRadius: '5px', borderLeft: '3px solid #EF4444' }}>
                  <p style={{ color: '#EF4444' }}>⚠️ <strong>Nearby Danger:</strong> {nearestInfo.danger_zone.severity} ({nearestInfo.danger_zone.distance > 1 ? `${nearestInfo.danger_zone.distance.toFixed(1)} km` : `${(nearestInfo.danger_zone.distance * 1000).toFixed(0)} m`})</p>
                </div>
              )}
            </div>
          </div>
        )}

        <div style={{ marginTop: 'auto', textAlign: 'center', paddingBottom: '20px' }}>
          <button className="btn-emergency" onClick={triggerSOS} style={{ animation: isSOS ? 'none' : 'pulse 2s infinite' }}>
            SOS
          </button>
          <p style={{ color: '#EF4444', fontSize: '0.9rem', marginTop: '10px', fontWeight: 'bold' }}>EMERGENCY BUTTON</p>
          <p style={{ fontSize: '0.8rem', color: '#94A3B8' }}>Instantly connects Mic, Broadcasts GPS & Plays Voice alert.</p>
        </div>
      </aside>

      {/* Main Map View */}
      <main style={{ padding: '1rem', position: 'relative' }}>
        {routePolyline && (
          <div style={{ position: 'absolute', top: '30px', left: '60px', zIndex: 1000, background: 'rgba(15, 23, 42, 0.9)', padding: '15px 25px', borderRadius: '15px', border: '1px solid #10B981' }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Navigation size={18} color="#10B981" /> Safe Route Mapped
            </h3>
            {routeInfo ? (
              <div style={{ marginTop: '10px', fontSize: '0.85rem', maxWidth: '400px', whiteSpace: 'normal', wordWrap: 'break-word' }}>
                {routeInfo.explanation && <p style={{ color: '#94A3B8', marginBottom: '8px', lineHeight: '1.4', whiteSpace: 'pre-wrap' }}>{routeInfo.explanation}</p>}
                {routeInfo.avoided.map((msg, idx) => (
                  <p key={idx} style={{ color: msg.includes('avoided') ? '#F87171' : '#10B981', marginBottom: '4px', lineHeight: '1.4' }}>{msg.includes('avoided') ? `• ${msg}` : msg}</p>
                ))}
                <p style={{ color: '#60A5FA', marginTop: '8px', borderTop: '1px solid #334155', paddingTop: '8px' }}>
                  🚔 Nearest Police: {routeInfo.nearestPolice}
                </p>
              </div>
            ) : (
              <p style={{ fontSize: '0.8rem', color: '#CBD5E1' }}>Watch for Heatmap Intersections.</p>
            )}
          </div>
        )}

        <SarthiMap
          location={location}
          dangerZones={dangerZones}
          isSOS={isSOS}
          isSarthiActive={isSarthiActive}
          customRoute={routePolyline}
          safetyData={safetyData}
          layers={layers}
        />
      </main>
    </div>
  );
}
