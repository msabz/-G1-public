import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
} from 'react-native-webrtc';

let pc = null;
let localStream = null;
let remoteStream = null;
let sendSignal = null;
let onStateChange = null;
let onDiag = null;
let connectTimer = null;
let settled = false;
let pendingCandidates = [];
let remoteDescSet = false;
let isCaller = false;
let restartTried = false;
let generation = 0;
let sawP2pCandidate = false;
let deferredCandidates = [];
let deferTimer = null;

const CONNECT_TIMEOUT_MS = 12000;

const RTC_CONFIG = {
  iceServers: [],
  iceCandidatePoolSize: 0,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

const AUDIO = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  googEchoCancellation: true,
  googAutoGainControl: true,
  googNoiseSuppression: true,
  googHighpassFilter: true,
};

function wantsVideo() {
  return global.__MUSABCHAT_WEBRTC_VIDEO__ === true;
}

function mediaConstraints() {
  return {
    audio: AUDIO,
    video: wantsVideo()
      ? {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24, max: 30 },
        }
      : false,
  };
}

export function isWebRTCAvailable() {
  try {
    return !!(RTCPeerConnection && mediaDevices && mediaDevices.getUserMedia);
  } catch (e) {
    return false;
  }
}

function diag(msg) {
  console.log('[RTC]', msg);
  if (onDiag) onDiag(msg);
}

function cleanup() {
  generation++;
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  if (deferTimer) { clearTimeout(deferTimer); deferTimer = null; }

  try {
    if (localStream) {
      localStream.getTracks().forEach(t => {
        try { t.enabled = false; } catch (e) {}
        try { t.stop(); } catch (e) {}
      });
      localStream.release && localStream.release();
    }
  } catch (e) {}

  try {
    if (pc && pc.getSenders) {
      pc.getSenders().forEach(sender => {
        try { if (sender.track) sender.track.stop(); } catch (e) {}
      });
    }
  } catch (e) {}

  try { if (pc) pc.close(); } catch (e) {}

  pc = null;
  localStream = null;
  remoteStream = null;
  settled = false;
  pendingCandidates = [];
  remoteDescSet = false;
  sawP2pCandidate = false;
  deferredCandidates = [];
}

function markConnected() {
  if (settled) return;
  settled = true;
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  diag('connected');
  if (onStateChange) onStateChange('connected');
}

async function flushPendingCandidates() {
  if (!pc || !remoteDescSet) return;
  const queued = pendingCandidates;
  pendingCandidates = [];
  for (const c of queued) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    } catch (e) {
      diag('candidate rejected: ' + (e?.message || ''));
    }
  }
  if (queued.length) diag(`flushed ${queued.length} candidates`);
}

function extractCandidateAddress(candidateStr) {
  const parts = (candidateStr || '').split(' ');
  return parts.length > 4 ? parts[4] : '';
}

function isP2pAddress(addr) {
  return addr.startsWith('192.168.49.');
}

function shouldSendCandidate(candidateStr) {
  const addr = extractCandidateAddress(candidateStr);
  if (!addr) return false;
  if (addr.endsWith('.local')) return false;
  return true;
}

function queueCandidate(c, send) {
  const addr = extractCandidateAddress(c.candidate);
  if (isP2pAddress(addr)) {
    sawP2pCandidate = true;
    deferredCandidates = [];
    if (deferTimer) { clearTimeout(deferTimer); deferTimer = null; }
    send(c);
    return;
  }

  if (sawP2pCandidate) return;
  deferredCandidates.push(c);
  if (!deferTimer) {
    deferTimer = setTimeout(() => {
      deferTimer = null;
      if (sawP2pCandidate) { deferredCandidates = []; return; }
      diag(`no p2p candidate, falling back to ${deferredCandidates.length} others`);
      deferredCandidates.forEach(send);
      deferredCandidates = [];
    }, 1500);
  }
}

function captureRemoteStream(event) {
  try {
    const stream = event?.streams?.[0];
    if (stream) {
      remoteStream = stream;
      const kinds = stream.getTracks().map(t => t.kind).join(',');
      diag(`remote stream: ${kinds || 'unknown'}`);
    }
  } catch (e) {
    diag('remote stream error: ' + (e?.message || ''));
  }
}

function buildPeer(onFailure) {
  const peer = new RTCPeerConnection(RTC_CONFIG);

  peer.addEventListener('icecandidate', event => {
    if (!event.candidate) {
      diag('gathering complete');
      return;
    }
    if (!sendSignal) return;
    const c = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
    if (!shouldSendCandidate(c.candidate)) return;

    const parts = (c.candidate || '').split(' ');
    const addr = parts[4] || '?';
    const typ = parts.indexOf('typ') >= 0 ? parts[parts.indexOf('typ') + 1] : '?';
    diag(`out ${typ} ${addr}`);
    queueCandidate(c, cand => sendSignal({ type: 'rtc-ice', candidate: cand }));
  });

  peer.addEventListener('iceconnectionstatechange', () => {
    const st = peer.iceConnectionState;
    diag('ice: ' + st);
    if (st === 'connected' || st === 'completed') markConnected();
    if (st === 'failed' && !settled) {
      if (!restartTried && isCaller) {
        restartTried = true;
        diag('ice restart');
        restartIce(onFailure);
        return;
      }
      if (onFailure) onFailure('فشل ICE');
    }
  });

  peer.addEventListener('connectionstatechange', () => {
    const st = peer.connectionState;
    diag('pc: ' + st);
    if (st === 'connected') markConnected();
    if ((st === 'failed' || st === 'closed') && !settled && onFailure) {
      onFailure('فشل اتصال WebRTC');
    }
  });

  peer.addEventListener('track', event => {
    captureRemoteStream(event);
    diag('remote track received: ' + (event?.track?.kind || '?'));
  });

  return peer;
}

async function restartIce(onFailure) {
  try {
    if (!pc) return;
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    if (sendSignal) {
      sendSignal({ type: 'rtc-offer', sdp: pc.localDescription.sdp, restart: true });
    }
  } catch (e) {
    if (onFailure) onFailure('تعذّرت إعادة تشغيل ICE');
  }
}

function closeAbortedStream(stream) {
  try {
    stream.getTracks().forEach(t => {
      t.enabled = false;
      t.stop();
    });
  } catch (e) {}
}

function configureCommon({ signalSender, onFailure, onState, onDiagnostic }) {
  sendSignal = signalSender;
  onStateChange = onState;
  onDiag = onDiagnostic;
  return onFailure;
}

export async function startAsCaller({ signalSender, onFailure, onState, onDiagnostic }) {
  cleanup();
  isCaller = true;
  restartTried = false;
  configureCommon({ signalSender, onFailure, onState, onDiagnostic });

  const myGen = generation;
  diag(`caller: requesting ${wantsVideo() ? 'audio+video' : 'audio'}`);
  const stream = await mediaDevices.getUserMedia(mediaConstraints());
  if (myGen !== generation) {
    closeAbortedStream(stream);
    diag('caller: aborted, call ended');
    return;
  }

  localStream = stream;
  pc = buildPeer(onFailure);
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  const offer = await pc.createOffer({
    offerToReceiveAudio: true,
    offerToReceiveVideo: wantsVideo(),
  });
  await pc.setLocalDescription(offer);
  sendSignal({ type: 'rtc-offer', sdp: pc.localDescription.sdp });
  diag('caller: offer sent');
  connectTimer = setTimeout(() => checkBeforeGivingUp(onFailure), CONNECT_TIMEOUT_MS);
}

function checkBeforeGivingUp(onFailure) {
  if (settled) return;
  try {
    const ice = pc && pc.iceConnectionState;
    const conn = pc && pc.connectionState;
    diag(`timeout check — ice:${ice} pc:${conn}`);
    if (ice === 'connected' || ice === 'completed' || conn === 'connected') {
      markConnected();
      return;
    }
    if (ice === 'checking' || ice === 'new') {
      diag('still checking, extending');
      connectTimer = setTimeout(() => {
        if (settled) return;
        const st = pc && pc.iceConnectionState;
        if (st === 'connected' || st === 'completed') {
          markConnected();
          return;
        }
        if (onFailure) onFailure('تعذّر إيجاد مسار بين الجهازين');
      }, 8000);
      return;
    }
  } catch (e) {}
  if (onFailure) onFailure('انتهت مهلة اتصال WebRTC');
}

export async function startAsCallee({ offerSdp, signalSender, onFailure, onState, onDiagnostic }) {
  const carried = pendingCandidates;
  cleanup();
  pendingCandidates = carried;
  isCaller = false;
  restartTried = false;
  configureCommon({ signalSender, onFailure, onState, onDiagnostic });

  const myGen = generation;
  diag(`callee: requesting ${wantsVideo() ? 'audio+video' : 'audio'}`);
  const stream = await mediaDevices.getUserMedia(mediaConstraints());
  if (myGen !== generation) {
    closeAbortedStream(stream);
    diag('callee: aborted, call ended');
    return;
  }

  localStream = stream;
  pc = buildPeer(onFailure);
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
  remoteDescSet = true;
  await flushPendingCandidates();

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal({ type: 'rtc-answer', sdp: pc.localDescription.sdp });
  diag('callee: answer sent');
  connectTimer = setTimeout(() => checkBeforeGivingUp(onFailure), CONNECT_TIMEOUT_MS);
}

export async function handleRestartOffer(offerSdp) {
  if (!pc) return false;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
    remoteDescSet = true;
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (sendSignal) sendSignal({ type: 'rtc-answer', sdp: pc.localDescription.sdp });
    diag('callee: restart answer sent');
    await flushPendingCandidates();
    return true;
  } catch (e) {
    diag('restart offer failed: ' + (e?.message || ''));
    return false;
  }
}

export function hasActivePeer() {
  return !!pc;
}

export async function acceptAnswer(sdp) {
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
  remoteDescSet = true;
  diag('caller: answer accepted');
  await flushPendingCandidates();
}

export async function addRemoteCandidate(candidate) {
  if (!candidate) return;
  if (candidate.candidate && !shouldSendCandidate(candidate.candidate)) return;
  const rp = (candidate.candidate || '').split(' ');
  diag(`in ${rp[7] || '?'} ${rp[4] || '?'}`);

  if (!pc || !remoteDescSet) {
    pendingCandidates.push(candidate);
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    diag('candidate error: ' + (e?.message || ''));
  }
}

export function setMicMuted(muted) {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
}

export function hasVideoTrack() {
  try {
    return !!localStream && localStream.getVideoTracks().length > 0;
  } catch (e) {
    return false;
  }
}

export function setCameraEnabled(enabled) {
  try {
    if (!localStream) return false;
    const tracks = localStream.getVideoTracks();
    tracks.forEach(t => { t.enabled = !!enabled; });
    return tracks.length > 0;
  } catch (e) {
    return false;
  }
}

export async function switchCamera() {
  try {
    const track = localStream?.getVideoTracks?.()[0];
    if (!track) return false;
    if (typeof track._switchCamera === 'function') {
      track._switchCamera();
      return true;
    }
    return false;
  } catch (e) {
    diag('switch camera failed: ' + (e?.message || ''));
    return false;
  }
}

export function getLocalStreamURL() {
  try {
    return localStream && typeof localStream.toURL === 'function' ? localStream.toURL() : null;
  } catch (e) {
    return null;
  }
}

export function getRemoteStreamURL() {
  try {
    return remoteStream && typeof remoteStream.toURL === 'function' ? remoteStream.toURL() : null;
  } catch (e) {
    return null;
  }
}

export function stop() {
  cleanup();
  sendSignal = null;
  onStateChange = null;
  onDiag = null;
}

export function hasLiveAudio() {
  try {
    if (!localStream) return false;
    return localStream.getAudioTracks().some(t => t.readyState === 'live' && t.enabled);
  } catch (e) {
    return false;
  }
}

export function isActive() {
  return !!pc && settled;
}
