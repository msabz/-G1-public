import * as RTCAudio from './WebRTCAudio';

// WebRTC is the only video engine. These compatibility wrappers remain only
// so App.js does not need a risky state-machine rewrite in the same change.
export function startCameraCapture() {
  global.__MUSABCHAT_WEBRTC_VIDEO__ = true;
  return Promise.resolve(true);
}

export function stopCameraCapture() {
  global.__MUSABCHAT_WEBRTC_VIDEO__ = false;
  try { RTCAudio.setCameraEnabled(false); } catch (e) {}
  return Promise.resolve(true);
}

export function switchCamera() {
  return RTCAudio.switchCamera();
}

// Legacy JPEG frames were removed. Keep a no-op subscription temporarily for
// App.js compatibility; no native CameraStreamModule is created or listened to.
export function onCameraFrame() {
  return { remove() {} };
}
