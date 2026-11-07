import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { API_ORIGIN } from '../config';

export const socket = io(API_ORIGIN);

// Haversine formula to calculate distance in meters
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // metres
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lon2-lon1) * Math.PI/180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
          Math.cos(φ1) * Math.cos(φ2) *
          Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c;
}

export function useTracker() {
  const [location, setLocation] = useState({ lat: 28.6139, lng: 77.2090 });
  const [isSarthiActive, setIsSarthiActive] = useState(false); // Manually turned on by user
  const [isSarthiAlarm, setIsSarthiAlarm] = useState(false); // Tripped by no movement
  const [isSOS, setIsSOS] = useState(false);
  const [sosDetails, setSosDetails] = useState(null); // Stores exact distress payload for UI

  // Start evidence recording immediately for 3 minutes and save to device
  const startLocalEvidenceRecording = () => {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        console.log("SOS Mic Active. Recording ambient evidence locally...");
        const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        const audioChunks = [];
        
        mediaRecorder.ondataavailable = e => {
          if (e.data.size > 0) audioChunks.push(e.data);
        };
        
        mediaRecorder.onstop = () => {
          const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
          const audioUrl = URL.createObjectURL(audioBlob);
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = audioUrl;
          a.download = `SOS_Emergency_Recording_${new Date().toISOString().replace(/[-:.]/g, '')}.webm`;
          document.body.appendChild(a);
          a.click();
          
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(audioUrl);
          }, 1000);
        };
        
        mediaRecorder.start(1000);
        
        setTimeout(() => {
          if (mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
            stream.getTracks().forEach(track => track.stop());
            console.log("SOS Evidence recording completed and saved to device.");
          }
        }, 180000); // 3 minutes
      })
      .catch(err => console.error("Mic access denied gracefully", err));
  };

  // Sync SOS state globally if the backend triggers it (e.g. from Voice Agent "help me")
  useEffect(() => {
    const handleRemoteEmergency = (data) => {
      setSosDetails(data); // Capture exact dispatch data to render on screen if triggered remotely
      if (!isSOS) {
        setIsSOS(true);
        startLocalEvidenceRecording(); // Actually start recording when AI triggers it remotely!
      }
      if ('speechSynthesis' in window) {
         window.speechSynthesis.cancel();
         const msg = new SpeechSynthesisUtterance("Emergency SOS received. Authorities and contacts have been digitally notified.");
         msg.rate = 1.0;
         msg.pitch = 1.0;
         msg.volume = 1;
         msg.lang = 'en-US';
         window.speechSynthesis.speak(msg);
      }
    };
    
    socket.on('emergency-broadcast-sent', handleRemoteEmergency);
    socket.on('emergency-alert', handleRemoteEmergency);
    
    return () => {
      socket.off('emergency-broadcast-sent', handleRemoteEmergency);
      socket.off('emergency-alert', handleRemoteEmergency);
    };
  }, [isSOS]);
  
  const [lastMovedTime, setLastMovedTime] = useState(Date.now());
  const historyRef = useRef([]);

  // Active Time Poller: Checks unconditionally if 60s have passed since last known movement
  useEffect(() => {
    let interval;
    if (isSarthiActive && !isSarthiAlarm) {
      interval = setInterval(() => {
        if (Date.now() - lastMovedTime >= 60000) { // 1 minute
          triggerSarthiAlarm(location);
        }
      }, 5000); // Polls every 5 seconds
    }
    return () => clearInterval(interval);
  }, [isSarthiActive, isSarthiAlarm, lastMovedTime, location]);

  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    
    // Initial request
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => console.log(err),
      { enableHighAccuracy: true }
    );

    const watchId = navigator.geolocation.watchPosition((pos) => {
      const newLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude, time: Date.now() };
      setLocation(newLoc);
      
      socket.emit('location-update', newLoc);
      
      const history = historyRef.current;
      const lastKnown = history.length > 0 ? history[history.length - 1] : null;

      if (lastKnown) {
        // If they genuinely traveled more than 5 meters since the very last ping, reset their timer!
        const dist = getDistance(lastKnown.lat, lastKnown.lng, newLoc.lat, newLoc.lng);
        if (dist > 5) {
          setLastMovedTime(Date.now());
        }
      } else {
        setLastMovedTime(Date.now()); // First lock
      }

      history.push(newLoc);
      
      // Keep only 65s of history to prevent memory leak
      const now = Date.now();
      while (history.length > 0 && now - history[0].time > 65000) {
        history.shift();
      }
      
    }, (err) => console.log(err), { enableHighAccuracy: true });

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const alarmTimerRef = useRef(null);

  const toggleSarthiMode = () => {
    const nextState = !isSarthiActive;
    setIsSarthiActive(nextState);
    if (!nextState) {
      setIsSarthiAlarm(false); // turn off alarm if user turns off Sarthi mode completely
    } else {
      setLastMovedTime(Date.now()); // Reset the 30s timer fresh from this exact moment
      // Announce activated via voice briefly
      if ('speechSynthesis' in window) {
        const msg = new SpeechSynthesisUtterance("Sarthi Mode has been activated. Monitoring movement.");
        msg.rate = 1.1;
        window.speechSynthesis.speak(msg);
      }
    }
  };

  const triggerSarthiAlarm = (currentLoc) => {
    setIsSarthiAlarm(true);
    socket.emit('sarthi-mode-engaged', currentLoc || location);
    
    // Play an audible voice message immediately
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance("Warning. Sarthi Mode parameter tripped. You have been stationary for too long. Opening microphone and alerting your emergency contacts immediately.");
      utterance.pitch = 1.2;
      utterance.rate = 0.9;
      utterance.volume = 1;
      utterance.lang = 'en-US';
      window.speechSynthesis.speak(utterance);
    }
    
    // Request Microphone access
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        console.log("Audio Stream active for Sarthi Alarm", stream);
      })
      .catch((err) => {
        console.error("Microphone denied", err);
      });
      
    // ── INDEPENDENT NODE ESCALATION ──
    // LangGraph Node logic: Wait 30 seconds for user input (cancel)
    // If no cancel, forcefully transition state to SOS Node
    if (alarmTimerRef.current) clearTimeout(alarmTimerRef.current);
    alarmTimerRef.current = setTimeout(() => {
        console.log("Sarthi Independent Node: 30s elapsed without input. Escalating to SOS Node.");
        triggerSOS();
        setIsSarthiAlarm(false); // Hide local alarm UI as full SOS takes over
    }, 30000); // 30 seconds
  };

  const triggerSOS = () => {
    setIsSOS(true);
    socket.emit('trigger-sos', location);
    
    if ('speechSynthesis' in window) {
       window.speechSynthesis.cancel();
       const msg = new SpeechSynthesisUtterance("SOS Initiated. Dispatching location to authorities and contacts.");
       msg.volume = 1;
       msg.rate = 1.0;
       msg.pitch = 1.0;
       msg.lang = 'en-US';
       window.speechSynthesis.speak(msg);
    }
    
    startLocalEvidenceRecording();
  };

  const cancelSarthiAlarm = () => {
    setIsSarthiAlarm(false);
    setLastMovedTime(Date.now()); // Restart the 60s clock
    
    // Clear the Independent Node escalation timer
    if (alarmTimerRef.current) clearTimeout(alarmTimerRef.current);
    
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel(); // Shut off the alarming voice instantly
    }
  };

  const cancelSOS = () => {
    setIsSOS(false);
    setSosDetails(null);
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel(); // Stop SOS voice messages
    }
  };

  return { 
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
  };
}
