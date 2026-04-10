import React, { useCallback, useEffect, useRef, useState } from "react";
import Webcam from "react-webcam";
import * as faceapi from "face-api.js";
import { useLocation } from "react-router-dom";
import { io } from "socket.io-client";

// ── Tuning constants ─────────────────────────────────────────────────────────
const DETECTION_INTERVAL  = 100;   // ms between SSD runs
const EMA_ALPHA           = 0.18;  // box smoothing (lower = smoother, less lag)
const RECOGNIZED_CONFIRM  = 4;     // consecutive "recognized" frames before blur lifts
const UNKNOWN_CONFIRM     = 6;     // consecutive "unknown" frames before blur returns
const IOU_THRESHOLD       = 0.15;  // min overlap to match a detection to a track
const BLUR_PADDING        = 70;    // px padding around detected box for blur region
const BLUR_STRENGTH       = "45px";
const MAX_MISSED_FRAMES   = 8;     // frames before expiring an unmatched track

// ── Helpers ──────────────────────────────────────────────────────────────────
const lerp = (a, b, t) => a + (b - a) * t;

function iou(a, b) {
  const ax2 = a.x + a.width,  ay2 = a.y + a.height;
  const bx2 = b.x + b.width,  by2 = b.y + b.height;
  const ix  = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy  = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (!inter) return 0;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

let _faceIdCounter = 0;
const newFaceId = () => `face_${++_faceIdCounter}`;

// ─────────────────────────────────────────────────────────────────────────────

function App() {
  const webcamRef            = useRef(null);
  const canvasRef            = useRef(null);
  const animationFrameRef    = useRef(null);
  const detectionFrameRef    = useRef(null);
  const peersRef             = useRef({});
  const socketRef            = useRef(null);
  const videoStreamRef       = useRef(null);
  const audioStreamRef       = useRef(null);
  const commentsContainerRef = useRef(null);

  // Face tracking: array of { id, x, y, width, height, recognizedCount,
  //   unknownCount, displayLabel, missedFrames }
  const trackedFacesRef      = useRef([]);
  // Latest raw SSD results written by async loop, read by render loop
  const latestDetectionsRef  = useRef([]);
  const detectionRunningRef  = useRef(false);
  const lastDetectionTimeRef = useRef(0);

  // Persistent offscreen canvas holding the pre-blurred full frame
  const blurOffscreenRef     = useRef(null);
  const lastBlurUpdateRef    = useRef(0);

  // Per-viewer ICE candidate queue
  const iceCandidateQueues   = useRef({});

  const faceMatcherRef       = useRef(null);
  const isRegisteredRef      = useRef(false);

  const location = useLocation();
  const roomId   = new URLSearchParams(location.search).get("room");

  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [faceMatcher,  setFaceMatcher]  = useState(null);
  // eslint-disable-next-line no-unused-vars
  const [ status, setStatus]       = useState("Loading models...");
  const [isRegistered, setIsRegistered] = useState(false);
  const [isStreaming,  setIsStreaming]  = useState(false);
  const [isMuted,      setIsMuted]      = useState(false);
  const [viewerCount,  setViewerCount]  = useState(0);
  const [comments,     setComments]     = useState([]);
  const [isTabActive,  setIsTabActive]  = useState(true);
  const [roomReady,    setRoomReady]    = useState(false);

  useEffect(() => { faceMatcherRef.current  = faceMatcher;  }, [faceMatcher]);
  useEffect(() => { isRegisteredRef.current = isRegistered; }, [isRegistered]);

  /* ---------------- Tab Visibility Detection ---------------- */
  useEffect(() => {
    const handleVisibilityChange = () => {
      const isActive = !document.hidden;
      setIsTabActive(isActive);
      if (socketRef.current && roomId) {
        socketRef.current.emit("host-video-state", { roomId, isPaused: !isActive });
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [roomId]);

  /* ---------------- Get Audio Stream ---------------- */
  useEffect(() => {
    const getAudioStream = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
            channelCount: 2,
          },
        });
        audioStreamRef.current = stream;
        console.log("Audio stream acquired");
      } catch (error) {
        console.error("Error getting audio:", error);
      }
    };
    getAudioStream();
    return () => {
      if (audioStreamRef.current)
        audioStreamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  /* ---------------- Centralized safe peer cleanup ---------------- */
  const cleanupPeer = useCallback((viewerId) => {
    const peer = peersRef.current[viewerId];
    if (peer) {
      try { peer.close(); } catch (_) {}
      delete peersRef.current[viewerId];
    }
    delete iceCandidateQueues.current[viewerId];
    setIsStreaming(Object.values(peersRef.current).some(p => p.connectionState === "connected"));
  }, []);

  /* ---------------- Peer creation ---------------- */
  const createPeerConnection = useCallback(async (viewerId) => {
    if (!canvasRef.current || !audioStreamRef.current) {
      console.error("Canvas or audio not ready for viewer:", viewerId);
      return;
    }

    if (peersRef.current[viewerId]) {
      console.log("Closing stale peer for viewer:", viewerId);
      cleanupPeer(viewerId);
    }

    const isStreamDead =
      !videoStreamRef.current ||
      videoStreamRef.current.getTracks().some((t) => t.readyState === "ended");
    if (isStreamDead) {
      console.log("Re-capturing canvas stream at 30fps");
      videoStreamRef.current = canvasRef.current.captureStream(30);
    }

    iceCandidateQueues.current[viewerId] = [];

    try {
      const peer = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
        ],
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
      });

      peersRef.current[viewerId] = peer;
      videoStreamRef.current.getTracks().forEach((t) => peer.addTrack(t, videoStreamRef.current));
      audioStreamRef.current.getTracks().forEach((t) => peer.addTrack(t, audioStreamRef.current));

      const applyEncodings = () => {
        peer.getSenders().forEach((sender) => {
          if (!sender.track) return;
          const parameters = sender.getParameters();
          if (!parameters.encodings || parameters.encodings.length === 0) {
            parameters.encodings = [{}];
          }
          if (sender.track.kind === "video") {
            parameters.encodings[0].maxBitrate = 2500000;
            parameters.encodings[0].maxFramerate = 30;
          } else if (sender.track.kind === "audio") {
            parameters.encodings[0].maxBitrate = 128000;
          }
          sender.setParameters(parameters).catch((err) =>
            console.warn("setParameters warning (non-critical):", err)
          );
        });
      };

      peer.onicecandidate = (event) => {
        if (event.candidate && socketRef.current) {
          socketRef.current.emit("ice-candidate", { to: viewerId, candidate: event.candidate });
        }
      };

      peer.onconnectionstatechange = () => {
        const state = peer.connectionState;
        console.log("Connection state for", viewerId, ":", state);
        if (state === "connected") applyEncodings();
        setIsStreaming(Object.values(peersRef.current).some(p => p.connectionState === "connected"));
        if (["disconnected", "failed", "closed"].includes(state)) cleanupPeer(viewerId);
      };

      peer.oniceconnectionstatechange = () => {
        if (peer.iceConnectionState === "failed") {
          console.warn("ICE failed for viewer:", viewerId, "— attempting restart");
          peer.restartIce();
        }
      };

      const offer = await peer.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
      await peer.setLocalDescription(offer);
      if (socketRef.current) {
        socketRef.current.emit("offer", { to: viewerId, offer });
        console.log("Offer sent to viewer:", viewerId);
      }
    } catch (error) {
      console.error("Error setting up peer for", viewerId, ":", error);
      cleanupPeer(viewerId);
    }
  }, [cleanupPeer]);

  /* ---------------- Socket ---------------- */
  useEffect(() => {
    socketRef.current = io("http://localhost:5000", {
      auth: { token: localStorage.getItem("token") },
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socketRef.current.on("connect", () => {
      if (!roomId) { console.error("No roomId in URL!"); return; }
      console.log("Socket connected, creating room:", roomId);
      socketRef.current.emit("create-room", roomId);
    });

    socketRef.current.on("reconnect", () => {
      console.log("Socket reconnected, re-creating room:", roomId);
      if (roomId) socketRef.current.emit("create-room", roomId);
    });

    socketRef.current.on("room-created", ({ roomId: createdRoomId }) => {
      console.log("Room created successfully:", createdRoomId);
      setRoomReady(true);
    });

    socketRef.current.on("room-already-exists", () => {
      console.warn("Room already exists — stale room may not have been cleared.");
    });

    socketRef.current.on("viewer-joined", (viewerId) => {
      console.log("Viewer joined:", viewerId);
      createPeerConnection(viewerId);
    });

    socketRef.current.on("answer", async ({ from, answer }) => {
      try {
        const peer = peersRef.current[from];
        if (!peer) { console.warn("Answer for unknown peer:", from); return; }
        if (peer.signalingState !== "have-local-offer") {
          console.warn("Ignoring answer for", from, "- wrong state:", peer.signalingState);
          return;
        }
        await peer.setRemoteDescription(new RTCSessionDescription(answer));
        console.log("Answer set for viewer:", from);
        const queued = iceCandidateQueues.current[from] || [];
        if (queued.length > 0) {
          console.log("Flushing", queued.length, "queued ICE candidates for", from);
          for (const candidate of queued) {
            try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { console.warn(e); }
          }
          iceCandidateQueues.current[from] = [];
        }
      } catch (error) {
        console.error("Error setting remote description:", error);
      }
    });

    socketRef.current.on("ice-candidate", async ({ from, candidate }) => {
      try {
        const peer = peersRef.current[from];
        if (!peer) return;
        if (!peer.remoteDescription) {
          (iceCandidateQueues.current[from] ??= []).push(candidate);
          console.log("ICE candidate queued for peer:", from);
        } else {
          await peer.addIceCandidate(new RTCIceCandidate(candidate));
        }
      } catch (error) {
        console.error("Error adding ICE candidate:", error);
      }
    });

    socketRef.current.on("viewer-count", (count) => setViewerCount(count));
    socketRef.current.on("new-comment", (comment) => setComments((prev) => [...prev, comment]));
    socketRef.current.on("viewer-left", (viewerId) => {
      console.log("Viewer left:", viewerId);
      cleanupPeer(viewerId);
    });

    return () => {
      
      Object.keys(peersRef.current).forEach((id) => cleanupPeer(id));
      if (videoStreamRef.current) {
        videoStreamRef.current.getTracks().forEach((t) => t.stop());
        videoStreamRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [roomId, createPeerConnection, cleanupPeer]);

  /* ---------------- Auto-scroll comments ---------------- */
  useEffect(() => {
    if (commentsContainerRef.current) {
      commentsContainerRef.current.scrollTop = commentsContainerRef.current.scrollHeight;
    }
  }, [comments]);

  /* ---------------- Load models ---------------- */
  useEffect(() => {
    const loadModels = async () => {
      const MODEL_URL = "/models";
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
      setModelsLoaded(true);
      setStatus("Models loaded");
    };
    loadModels();
  }, []);

  /* ---------------- Load registered face from localStorage ---------------- */
  useEffect(() => {
    const stored = localStorage.getItem("registeredFace");
    if (stored) {
      const labeled = new faceapi.LabeledFaceDescriptors("Registered User", [
        new Float32Array(JSON.parse(stored)),
      ]);
      const matcher = new faceapi.FaceMatcher([labeled], 0.6);
      setFaceMatcher(matcher);
      setIsRegistered(true);
      setStatus("Registered face loaded");
    } else {
      setStatus("Please register your face first");
    }
  }, []);

  /* ---------------- Controls ---------------- */
  const toggleMute = () => {
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((track) => { track.enabled = !track.enabled; });
      setIsMuted(!isMuted);
    }
  };

  // eslint-disable-next-line no-unused-vars
  const registerFace = async () => {
    if (!modelsLoaded || isRegistered) return;
    const imageSrc = webcamRef.current.getScreenshot();
    const img = await faceapi.fetchImage(imageSrc);
    const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
    if (!detection) {
      alert("No face detected! Please ensure good lighting and face the camera.");
      return;
    }
    localStorage.setItem("registeredFace", JSON.stringify(Array.from(detection.descriptor)));
    const labeled = new faceapi.LabeledFaceDescriptors("Registered User", [detection.descriptor]);
    const matcher = new faceapi.FaceMatcher([labeled], 0.6);
    setFaceMatcher(matcher);
    setIsRegistered(true);
    setStatus("Face registered");
  };

  // eslint-disable-next-line no-unused-vars
  const removeFace = () => {
    localStorage.removeItem("registeredFace");
    setFaceMatcher(null);
    setIsRegistered(false);
    trackedFacesRef.current = [];
    setStatus("Registered face removed");
  };

  /* ─────────────────────────────────────────────────────────────────────────
     OFFSCREEN BLUR PRE-RENDERER
     Renders a fully-blurred + mirrored copy of the video onto a persistent
     offscreen canvas at ~100ms cadence. The render loop blits regions from
     this stable image — eliminates per-frame ctx.filter flicker on main canvas.
     ───────────────────────────────────────────────────────────────────────── */
  const updateBlurOffscreen = useCallback((videoEl, W, H) => {
    const now = Date.now();
    if (now - lastBlurUpdateRef.current < DETECTION_INTERVAL * 0.85) return;
    lastBlurUpdateRef.current = now;

    if (!blurOffscreenRef.current) blurOffscreenRef.current = document.createElement("canvas");
    const off = blurOffscreenRef.current;
    if (off.width  !== W) off.width  = W;
    if (off.height !== H) off.height = H;

    const ctx = off.getContext("2d");
    ctx.save();
    ctx.filter = `blur(${BLUR_STRENGTH})`;
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(videoEl, 0, 0, W, H);
    ctx.restore();
    ctx.filter = "none"; // always reset — prevent filter leak
  }, []);

  /* ─────────────────────────────────────────────────────────────────────────
     ASYNC DETECTION LOOP (setTimeout-based, fully decoupled from rAF)
     Runs ssdMobilenetv1 asynchronously. Results stored in latestDetectionsRef.
     ───────────────────────────────────────────────────────────────────────── */
  const runDetectionLoop = useCallback(() => {
    if (!modelsLoaded) return;
    detectionRunningRef.current = true;

    const detect = async () => {
      if (!detectionRunningRef.current) return;
      const now     = Date.now(); 
      const videoEl = webcamRef.current?.video;

      if (videoEl?.readyState === 4 && now - lastDetectionTimeRef.current >= DETECTION_INTERVAL) {
        try {
          latestDetectionsRef.current = await faceapi
            .detectAllFaces(videoEl, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }))
            .withFaceLandmarks()
            .withFaceDescriptors();
          lastDetectionTimeRef.current = Date.now();
        } catch (_) { /* tab hidden / video not ready */ }
      }

      detectionFrameRef.current = setTimeout(detect, 33);
    };

    detect();
  }, [modelsLoaded]);

  /* ─────────────────────────────────────────────────────────────────────────
     SYNC RENDER LOOP (rAF — zero async work)

     Each frame:
       1. Draw mirrored video to main canvas
       2. Refresh offscreen blur (throttled to ~100ms)
       3. Update tracked face list:
            - IoU-match detections → existing tracks
            - EMA-smooth box positions (eliminates jitter)
            - Hysteresis update of displayLabel (eliminates label flipping)
            - Expire tracks missing > MAX_MISSED_FRAMES (handles occlusion)
            - Spawn new tracks for unmatched detections
       4. Blit pre-blurred regions for unknown faces (no ctx.filter on main canvas)
       5. Draw overlay boxes + labels
     ───────────────────────────────────────────────────────────────────────── */
  const renderLoop = useCallback(() => {
    const videoEl = webcamRef.current?.video;
    const canvas  = canvasRef.current;

    if (videoEl?.readyState === 4 && canvas) {
      const W = videoEl.videoWidth;
      const H = videoEl.videoHeight;
      if (canvas.width  !== W) canvas.width  = W;
      if (canvas.height !== H) canvas.height = H;

      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      // 1. Draw mirrored video
      ctx.save();
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(videoEl, 0, 0, W, H);
      ctx.restore();

      // 2. Refresh offscreen blur (rate-limited internally)
      updateBlurOffscreen(videoEl, W, H);

      // 3. Build target boxes from latest detections (mirror X to match flipped canvas)
      const resized = faceapi.resizeResults(latestDetectionsRef.current, { width: W, height: H });

      const targets = resized.map((det) => ({
        x:          W - det.detection.box.x - det.detection.box.width,
        y:          det.detection.box.y,
        width:      det.detection.box.width,
        height:     det.detection.box.height,
        descriptor: det.descriptor,
      }));

      // IoU match + EMA smooth + hysteresis update
      const matched       = new Set();
      const updatedTracks = [];

      for (const track of trackedFacesRef.current) {
        let bestScore = IOU_THRESHOLD;
        let bestIdx   = -1;

        targets.forEach((tgt, i) => {
          if (matched.has(i)) return;
          const score = iou(track, tgt);
          if (score > bestScore) { bestScore = score; bestIdx = i; }
        });

        if (bestIdx !== -1) {
          matched.add(bestIdx);
          const tgt = targets[bestIdx];

          // EMA smooth box position — eliminates jitter from raw SSD output
          const sx = lerp(track.x,      tgt.x,      EMA_ALPHA);
          const sy = lerp(track.y,      tgt.y,      EMA_ALPHA);
          const sw = lerp(track.width,  tgt.width,  EMA_ALPHA);
          const sh = lerp(track.height, tgt.height, EMA_ALPHA);

          // Raw label from matcher
          let rawLabel = "unknown";
          if (isRegisteredRef.current && faceMatcherRef.current)
            rawLabel = faceMatcherRef.current.findBestMatch(tgt.descriptor).label;

          // Hysteresis — prevents single-frame label flips from toggling blur
          let { recognizedCount, unknownCount, displayLabel } = track;
          if (rawLabel === "Registered User") {
            recognizedCount = Math.min(recognizedCount + 1, RECOGNIZED_CONFIRM + 4);
            unknownCount    = 0;
            if (recognizedCount >= RECOGNIZED_CONFIRM) displayLabel = "Registered User";
          } else {
            unknownCount    = Math.min(unknownCount + 1, UNKNOWN_CONFIRM + 4);
            recognizedCount = 0;
            if (unknownCount >= UNKNOWN_CONFIRM) displayLabel = "unknown";
          }

          updatedTracks.push({
            ...track,
            x: sx, y: sy, width: sw, height: sh,
            recognizedCount, unknownCount, displayLabel,
            missedFrames: 0,
          });
        } else {
          // No IoU match — keep track alive during occlusion grace period
          if (track.missedFrames < MAX_MISSED_FRAMES) {
            updatedTracks.push({ ...track, missedFrames: track.missedFrames + 1 });
          }
          // else: track expires — face has left frame
        }
      }

      // Spawn new tracks for unmatched targets
      for (let i = 0; i < targets.length; i++) {
        if (matched.has(i)) continue;
        updatedTracks.push({
          id:             newFaceId(),
          ...targets[i],
          recognizedCount: 0,
          unknownCount:    1,
          displayLabel:    "unknown", // always start unknown; hysteresis lifts blur if registered
          missedFrames:    0,
        });
      }

      trackedFacesRef.current = updatedTracks;

      // 4 + 5. Draw blur regions and boxes
      let currentStatus = updatedTracks.length === 0 ? "No face detected" : "Processing...";

      ctx.lineWidth = 4;
      ctx.font      = "bold 18px Arial";

      for (const track of updatedTracks) {
        const { x, y, width, height, displayLabel } = track;

        if (!isRegisteredRef.current || displayLabel !== "Registered User") {
          // ── Unknown face: blit from pre-blurred offscreen — zero ctx.filter ──
          const pad = BLUR_PADDING;
          const bx  = Math.max(0,     x - pad / 2);
          const by  = Math.max(0,     y - pad / 2);
          const bw  = Math.min(W - bx, width  + pad);
          const bh  = Math.min(H - by, height + pad + 25);

          if (blurOffscreenRef.current) {
            // Stable blit from pre-blurred offscreen — no flicker
            ctx.drawImage(blurOffscreenRef.current, bx, by, bw, bh, bx, by, bw, bh);
          }

          // Semi-transparent red fill
          ctx.fillStyle = "rgba(239,68,68,0.18)";
          ctx.fillRect(bx, by, bw, bh);

          // Red border
          ctx.strokeStyle = "#ef4444";
          ctx.strokeRect(bx, by, bw, bh);

          // Label
          ctx.fillStyle = "#ef4444";
          ctx.fillText("Unknown", bx + 5, Math.max(18, by - 10));

          currentStatus = isRegisteredRef.current
            ? "Unknown face detected"
            : "Please register your face first";
        } else {
          // ── Registered face: green box, no blur ──────────────────────────────
          ctx.strokeStyle = "#22c55e";
          ctx.fillStyle   = "rgba(34,197,94,0.08)";
          ctx.strokeRect(x, y - 35, width, height + 45);
          ctx.fillRect(x, y - 35, width, height + 45);

          ctx.fillStyle = "#22c55e";
          ctx.fillText("Registered User", x + 5, y - 42);

          currentStatus = "Registered face detected";
        }
      }

      // Guard setStatus — prevent React re-render on every rAF frame
      setStatus((prev) => (prev !== currentStatus ? currentStatus : prev));
    }

    animationFrameRef.current = requestAnimationFrame(renderLoop);
  }, [updateBlurOffscreen]);

  /* ---------------- Start both loops when models are ready ---------------- */
  useEffect(() => {
    if (!modelsLoaded) return;
    animationFrameRef.current = requestAnimationFrame(renderLoop);
    runDetectionLoop();
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      detectionRunningRef.current = false;
      if (detectionFrameRef.current) clearTimeout(detectionFrameRef.current);
    };
  }, [modelsLoaded, renderLoop, runDetectionLoop]);

  /* ---------------- Render (your UI — unchanged) ---------------- */
  return (
    <div style={styles.page}>
      <style>{keyframes}</style>
      <div style={styles.mainContainer}>
        <div style={styles.leftSection}>
          <div style={styles.card}>
            <div style={styles.header}>
              <h1 style={styles.title}>Live Stream</h1>
              <div style={styles.badgeRow}>
                <div style={styles.firstRow}>
                  {roomReady && (
                    <div style={styles.roomReadyBadge}>Room: {roomId}</div>
                  )}
                  {isStreaming && (
                    <div style={styles.streamingBadge}>
                      <span style={styles.liveDot}></span>LIVE
                    </div>
                  )}
                  {isMuted && <div style={styles.mutedBadge}>MUTED</div>}
                  <div style={styles.viewerBadge}>{viewerCount} watching</div>
                </div>
                <div style={styles.buttonRow}>
                  <button
                    style={{ ...styles.button, ...styles.muteButton }}
                    onClick={toggleMute}
                  >
                    {isMuted ? "Unmute" : "Mute"}
                  </button>
                </div>
              </div>
            </div>
            <div style={styles.cameraBox}>
              {!isTabActive && (
                <div style={styles.pausedOverlay}>
                  <h2 style={{ color: "#fff" }}>Stream Paused</h2>
                  <p style={{ color: "#94a3b8" }}>
                    Return to this tab to resume
                  </p>
                </div>
              )}
              <Webcam
                ref={webcamRef}
                audio={false}
                screenshotFormat="image/jpeg"
                videoConstraints={{
                  width: { ideal: 1920 },
                  height: { ideal: 1080 },
                  frameRate: { ideal: 60 },
                  facingMode: "user",
                }}
                style={styles.webcam}
              />
              <canvas ref={canvasRef} style={styles.canvas} />
            </div>
          </div>
        </div>
        <div style={styles.rightSection}>
          <div style={styles.commentsCard}>
            <h3 style={styles.commentsTitle}>Live Chat</h3>
            <div
              ref={commentsContainerRef}
              style={styles.commentsContainer}
            >
              {comments.length === 0 ? (
                <p style={styles.noComments}>
                  No comments yet. Viewers can start chatting!
                </p>
              ) : (
                comments.map((comment, index) => (
                  <div
                    key={`${comment.timestamp}-${index}`}
                    style={styles.commentItem}
                  >
                    <span style={styles.commentUsername}>
                      {comment.username}:
                    </span>
                    <span style={styles.commentText}>{comment.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;

const keyframes = `
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  @keyframes slideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
`;

const styles = {
  page: { minHeight: "100vh", background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #020617 100%)", display: "flex", alignItems: "flex-start", justifyContent: "center", fontFamily: "system-ui, -apple-system, sans-serif", padding: "20px" },
  mainContainer: { display: "flex", gap: "20px", width: "100%", maxWidth: "1600px", flexWrap: "wrap" },
  leftSection: { flex: "1 1 800px", minWidth: "300px" },
  rightSection: { flex: "0 0 350px", minWidth: "300px" },
  card: { backgroundColor: "#0b1220", padding: "28px", borderRadius: "20px", boxShadow: "0 25px 70px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.05)", animation: "fadeIn 0.5s ease" },
  header: { marginBottom: "20px" },
  title: { fontSize: "32px", fontWeight: "700", marginBottom: "15px", background: "linear-gradient(135deg, #38bdf8, #818cf8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" },
  badgeRow: { display: "flex", flexWrap: "wrap", width: "100%", justifyContent: "space-between", alignItems: "center" },
  roomReadyBadge: { display: "flex", alignItems: "center", backgroundColor: "rgba(34,197,94,0.2)", padding: "8px 16px", borderRadius: "20px", fontSize: "13px", fontWeight: "600", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" },
  streamingBadge: { display: "flex", alignItems: "center", gap: "8px", backgroundColor: "#7f1d1d", padding: "8px 16px", borderRadius: "20px", fontSize: "13px", fontWeight: "600", color: "#fff", animation: "slideIn 0.3s ease" },
  mutedBadge: { display: "flex", alignItems: "center", backgroundColor: "#ea580c", padding: "8px 16px", borderRadius: "20px", fontSize: "13px", fontWeight: "600", color: "#fff" },
  viewerBadge: { display: "flex", alignItems: "center", backgroundColor: "rgba(56,189,248,0.2)", padding: "8px 16px", borderRadius: "20px", fontSize: "13px", fontWeight: "600", color: "#38bdf8", border: "1px solid rgba(56,189,248,0.3)" },
  liveDot: { width: "10px", height: "10px", borderRadius: "50%", backgroundColor: "#ef4444", animation: "pulse 2s infinite", display: "inline-block" },
  cameraBox: { position: "relative", width: "80%", aspectRatio: "16 / 9", overflow: "hidden", borderRadius: "16px", backgroundColor: "#000", marginLeft: "80px" },
  pausedOverlay: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", backgroundColor: "rgba(0,0,0,0.9)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 10 },
  webcam: { width: "80%", height: "80%", objectFit: "cover", transform: "scaleX(-1)", overflow: "hidden" },
  canvas: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" },
  buttonRow: { display: "flex", gap: "12px", marginTop: "20px", flexWrap: "wrap", justifyContent: "center" },
  button: { padding: "14px 24px", borderRadius: "12px", border: "none", fontSize: "15px", fontWeight: "600", cursor: "pointer", background: "linear-gradient(135deg, #38bdf8, #0ea5e9)", color: "#fff", boxShadow: "0 8px 20px rgba(14,165,233,0.4)" },
  removeButton: { background: "linear-gradient(135deg, #ef4444, #dc2626)", boxShadow: "0 8px 20px rgba(239,68,68,0.4)" },
  muteButton: { background: "linear-gradient(135deg, #f59e0b, #d97706)", boxShadow: "0 8px 20px rgba(245,158,11,0.4)" },
  statusRow: { marginTop: "16px", display: "flex", flexDirection: "column", gap: "8px", alignItems: "center" },
  status: { fontSize: "15px", fontWeight: "500", color: "#94a3b8", textAlign: "center" },
  roomId: { fontSize: "14px", color: "#64748b", textAlign: "center" },
  peerInfo: { fontSize: "12px", color: "#475569", textAlign: "center", fontStyle: "italic" },
  commentsCard: { backgroundColor: "#0b1220", padding: "24px", borderRadius: "20px", boxShadow: "0 25px 70px rgba(0,0,0,0.7)", height: "calc(100vh - 40px)", display: "flex", flexDirection: "column" },
  commentsTitle: { fontSize: "20px", fontWeight: "600", color: "#e2e8f0", marginBottom: "16px", paddingBottom: "12px", borderBottom: "1px solid rgba(255,255,255,0.1)" },
  commentsContainer: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px", paddingRight: "8px" },
  noComments: { color: "#64748b", textAlign: "center", fontSize: "14px", marginTop: "40px" },
  commentItem: { backgroundColor: "rgba(56,189,248,0.1)", padding: "12px", borderRadius: "12px", borderLeft: "3px solid #38bdf8", animation: "slideIn 0.3s ease" },
  commentUsername: { fontWeight: "700", color: "#38bdf8", marginRight: "8px", fontSize: "14px" },
  commentText: { color: "#e2e8f0", fontSize: "14px", lineHeight: "1.5" },
  firstRow: { display: "flex", gap: "10px", height: "40px" },
};