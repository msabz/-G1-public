import { mediaDevices, RTCPeerConnection, MediaStream } from 'react-native-webrtc';
import { sendSignalingMessage } from './signaling';

let pc = null;
let localStream = null;
let remoteStream = new MediaStream();
let dataChannel = null;
let onRemoteStreamCallback = null;
let onDataChannelMessageCallback = null;
let onDataChannelOpenCallback = null;
let onConnectionStateChangeCallback = null;
let onHangupReceivedCallback = null;
let remoteDescSet = false;
let remoteIceQueue = [];
let myIp = null;

function rewriteMdns(str) {
  if (!str || !myIp) return str;
  return str.replace(/[0-9a-fA-F-]{8,}\.local/g, myIp);
}

export function setLocalIp(ip) { myIp = ip; }

let onDebugCallback = null;
let sentCandCount = 0;
let recvCandCount = 0;
let offerRecvCount = 0;
let answerRecvCount = 0;
let myRole = '?';
export function setOnDebugInfo(cb) { onDebugCallback = cb; }
export function setDebugRole(role) { myRole = role; }
function emitDebug() {
  if (!onDebugCallback) return;
  const iceState = pc ? pc.iceConnectionState : 'no-pc';
  const gatherState = pc ? pc.iceGatheringState : 'no-pc';
  const connState = pc ? pc.connectionState : 'no-pc';
  onDebugCallback(`Role:${myRole} ICE:${iceState} Conn:${connState} SentC:${sentCandCount} RecvC:${recvCandCount} RecvOffer:${offerRecvCount} RecvAnswer:${answerRecvCount}`);
}

const config = { iceServers: [] };

export async function startLocalStream() {
  localStream = await mediaDevices.getUserMedia({
    audio: true,
    video: { width: 640, height: 480, frameRate: 30 },
  });
  return localStream;
}

export function stopLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
}

function setupDataChannel() {
  if (!dataChannel) return;
  dataChannel.onopen = () => onDataChannelOpenCallback?.();
  dataChannel.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'hangup') onHangupReceivedCallback?.();
      else onDataChannelMessageCallback?.(e.data);
    } catch {
      onDataChannelMessageCallback?.(e.data);
    }
  };
}

export function createPeerConnection(isInitiator) {
  if (pc) pc.close();
  pc = new RTCPeerConnection(config);
  sentCandCount = 0;
  recvCandCount = 0;

  const pcRef = pc;
  setTimeout(() => {
    if (pc === pcRef && sentCandCount === 0 && pc.iceGatheringState !== 'complete') {
      console.warn('لم يتم تجميع أي عنوان اتصال - إعادة تشغيل ICE');
      try { pc.restartIce(); } catch (e) { console.warn('restartIce failed', e.message); }
    }
  }, 4000);

  pc.oniceconnectionstatechange = () => emitDebug();
  pc.onicegatheringstatechange = () => emitDebug();

  pc.onicecandidate = event => {
    if (event.candidate) {
      sentCandCount++;
      const rewritten = {
        candidate: rewriteMdns(event.candidate.candidate),
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      };
      sendSignalingMessage({ type: 'candidate', candidate: rewritten });
    }
    emitDebug();
  };

  pc.ontrack = event => {
    const alreadyAdded = remoteStream.getTracks().some(t => t.id === event.track.id);
    if (!alreadyAdded) remoteStream.addTrack(event.track);
    if (onRemoteStreamCallback) onRemoteStreamCallback(remoteStream);
  };

  if (isInitiator) {
    dataChannel = pc.createDataChannel('chat');
    setupDataChannel();
  } else {
    pc.ondatachannel = event => {
      dataChannel = event.channel;
      setupDataChannel();
    };
  }

  pc.onconnectionstatechange = () => {
    onConnectionStateChangeCallback?.(pc.connectionState);
    emitDebug();
  };

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  remoteDescSet = false;
  remoteIceQueue = [];
}

export async function createOffer() {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignalingMessage({ type: 'offer', sdp: rewriteMdns(pc.localDescription.sdp) });
}

export async function handleOffer(sdp) {
  await pc.setRemoteDescription({ type: 'offer', sdp });
  remoteDescSet = true;
  processRemoteIceQueue();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignalingMessage({ type: 'answer', sdp: rewriteMdns(pc.localDescription.sdp) });
}

export async function handleAnswer(sdp) {
  await pc.setRemoteDescription({ type: 'answer', sdp });
  remoteDescSet = true;
  processRemoteIceQueue();
}

export async function addIceCandidate(candidate) {
  recvCandCount++;
  if (!remoteDescSet) {
    remoteIceQueue.push(candidate);
  } else {
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      console.warn('addIceCandidate failed:', e.message);
    }
  }
  emitDebug();
}

function processRemoteIceQueue() {
  while (remoteIceQueue.length) {
    const c = remoteIceQueue.shift();
    pc.addIceCandidate(c).catch(e => console.warn('delayed ice fail', e.message));
  }
}

let onSignalingErrorCallback = null;
export function setOnSignalingError(cb) { onSignalingErrorCallback = cb; }

export async function onSignalingMessage(msg) {
  if (msg.type === 'offer') offerRecvCount++;
  if (msg.type === 'answer') answerRecvCount++;
  try {
    switch (msg.type) {
      case 'offer': await handleOffer(msg.sdp); break;
      case 'answer': await handleAnswer(msg.sdp); break;
      case 'candidate': await addIceCandidate(msg.candidate); break;
    }
  } catch (e) {
    console.warn('onSignalingMessage error:', e?.message);
    onSignalingErrorCallback?.(e);
  }
  emitDebug();
}

export function setOnRemoteStream(cb) { onRemoteStreamCallback = cb; }
export function setOnDataChannelMessage(cb) { onDataChannelMessageCallback = cb; }
export function setOnDataChannelOpen(cb) { onDataChannelOpenCallback = cb; }
export function setOnConnectionStateChange(cb) { onConnectionStateChangeCallback = cb; }
export function setOnHangupReceived(cb) { onHangupReceivedCallback = cb; }

export function sendChatMessage(text) {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(text);
    return true;
  }
  return false;
}

function waitForBufferFlush(cb, attempts = 0) {
  if (!dataChannel || attempts > 10) { cb?.(); return; }
  if (dataChannel.bufferedAmount === 0) { cb?.(); return; }
  setTimeout(() => waitForBufferFlush(cb, attempts + 1), 50);
}

export function sendHangup(onFlushed) {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'hangup' }));
    waitForBufferFlush(onFlushed);
  } else {
    onFlushed?.();
  }
}

export function toggleMicrophone() {
  const track = localStream?.getAudioTracks()[0];
  if (track) track.enabled = !track.enabled;
  return track ? track.enabled : null;
}

export function toggleCamera() {
  const track = localStream?.getVideoTracks()[0];
  if (track) track.enabled = !track.enabled;
  return track ? track.enabled : null;
}

export function closeConnection() {
  if (pc) { pc.close(); pc = null; }
  remoteStream = new MediaStream();
  dataChannel = null;
  remoteIceQueue = [];
  remoteDescSet = false;
}
