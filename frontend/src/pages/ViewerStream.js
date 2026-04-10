import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { io } from "socket.io-client";

export default function ViewerStream() {
  const videoRef = useRef(null);
  const peerRef = useRef(null);
  const socketRef = useRef(null);
  const offerReceivedRef = useRef(false);
  const pendingCandidatesRef = useRef([]);
  const commentsContainerRef = useRef(null);
  const pendingStreamRef = useRef(null);

  const [noHost, setNoHost] = useState(false);
  const [canPlay, setCanPlay] = useState(false);
  const [connectionState, setConnectionState] = useState("connecting");
  const [volume, setVolume] = useState(1);
  const [comments, setComments] = useState([]);
  const [commentText, setCommentText] = useState("");
  const [username, setUsername] = useState("");
  const [isUsernameSet, setIsUsernameSet] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [isHostPaused, setIsHostPaused] = useState(false);

  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const roomId = query.get("room");

  /* Apply pending stream when video element is ready */
  useEffect(() => {
    if (videoRef.current && pendingStreamRef.current) {
      videoRef.current.srcObject = pendingStreamRef.current;
      pendingStreamRef.current = null;
    }
  }, [isUsernameSet]);

  useEffect(() => {
    if (!isUsernameSet) return;

    socketRef.current = io("https://privacy-control-live-streaming-1.onrender.com", {
      auth: { token: localStorage.getItem("token") },
      // IMPROVEMENT: Reconnection config for transient network drops
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    // IMPROVEMENT: Emit join-room only after socket is connected — the original bug
    // emitting immediately after io() loses the event since the socket isn't connected yet
    socketRef.current.on("connect", () => {
      console.log("Socket connected, joining room:", roomId);
      socketRef.current.emit("join-room", roomId);
    });

    // IMPROVEMENT: Re-join after socket reconnects (handles brief network drops)
    socketRef.current.on("reconnect", () => {
      console.log("Socket reconnected, re-joining room:", roomId);
      socketRef.current.emit("join-room", roomId);
    });

    const timeout = setTimeout(() => {
      if (!offerReceivedRef.current) {
        console.log("No offer received within 15 seconds");
        setNoHost(true);
      }
    }, 15000); // IMPROVEMENT: Increased from 10s — gives more time for slow networks/ICE

    // IMPROVEMENT: Retry joining if room not found — handles host/viewer race condition
    socketRef.current.on("room-not-found", () => {
      console.warn("Room not found — retrying in 2s...");
      setTimeout(() => {
        if (socketRef.current?.connected) {
          socketRef.current.emit("join-room", roomId);
        }
      }, 2000);
    });

    /* ---------- OFFER ---------- */
    socketRef.current.on("offer", async ({ from, offer }) => {
      console.log("Offer received from:", from);
      offerReceivedRef.current = true;
      setNoHost(false);
      clearTimeout(timeout);

      // IMPROVEMENT: Close any existing stale peer before creating a new one
      if (peerRef.current) {
        try { peerRef.current.close(); } catch (_) {}
        peerRef.current = null;
      }

      try {
        peerRef.current = new RTCPeerConnection({
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" }
          ],
          // IMPROVEMENT: Match host peer config — bundle all tracks on one transport
          bundlePolicy: "max-bundle",
          rtcpMuxPolicy: "require"
        });

        peerRef.current.ontrack = (event) => {
          console.log("Track received:", event.track.kind);
          const stream = event.streams[0];
          if (videoRef.current) {
            if (!videoRef.current.srcObject) {
              videoRef.current.srcObject = stream;
            } else {
              const existingStream = videoRef.current.srcObject;
              stream.getTracks().forEach(track => {
                if (!existingStream.getTracks().find(t => t.kind === track.kind)) {
                  existingStream.addTrack(track);
                }
              });
            }
          } else {
            pendingStreamRef.current = stream;
            console.log("Stream stored, waiting for video element");
          }
        };

        peerRef.current.onicecandidate = (event) => {
          if (event.candidate) {
            socketRef.current.emit("ice-candidate", { to: from, candidate: event.candidate });
          }
        };

        peerRef.current.onconnectionstatechange = () => {
          const state = peerRef.current?.connectionState;
          if (!state) return;
          console.log("Connection State:", state);
          setConnectionState(state);
          if (state === "connected") setNoHost(false);
          if (state === "disconnected" || state === "failed") setNoHost(true);
        };

        // IMPROVEMENT: ICE restart on failure — attempts recovery before showing "stream ended"
        peerRef.current.oniceconnectionstatechange = () => {
          const iceState = peerRef.current?.iceConnectionState;
          console.log("ICE Connection State:", iceState);
          if (iceState === "failed") {
            console.warn("ICE failed — attempting restart");
            peerRef.current?.restartIce();
          }
        };

        await peerRef.current.setRemoteDescription(new RTCSessionDescription(offer));
        console.log("Remote description set");

        // IMPROVEMENT: Flush candidates queued before remote description was set
        for (const candidate of pendingCandidatesRef.current) {
          try {
            await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.warn("Error flushing queued candidate:", e);
          }
        }
        pendingCandidatesRef.current = [];

        const answer = await peerRef.current.createAnswer();
        await peerRef.current.setLocalDescription(answer);
        socketRef.current.emit("answer", { to: from, answer });
        console.log("Answer sent");
      } catch (error) {
        console.error("Error handling offer:", error);
        setNoHost(true);
      }
    });

    /* ---------- ICE Candidate ---------- */
    socketRef.current.on("ice-candidate", async ({ candidate }) => {
      try {
        if (!peerRef.current || !peerRef.current.remoteDescription) {
          // IMPROVEMENT: Queue candidates — flushed after setRemoteDescription in offer handler
          pendingCandidatesRef.current.push(candidate);
          console.log("ICE candidate queued");
        } else {
          await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate));
          console.log("ICE candidate added");
        }
      } catch (error) {
        console.error("Error adding ICE candidate:", error);
      }
    });

    /* ---------- Comments ---------- */
    socketRef.current.on("existing-comments", (existingComments) => {
      setComments(existingComments);
    });

    socketRef.current.on("new-comment", (comment) => {
      setComments(prev => [...prev, comment]);
    });

    /* ---------- Viewer Count ---------- */
    socketRef.current.on("viewer-count", (count) => {
      setViewerCount(count);
    });

    /* ---------- Host Paused ---------- */
    socketRef.current.on("host-video-paused", (isPaused) => {
      setIsHostPaused(isPaused);
    });

    /* ---------- Host Disconnected ---------- */
    socketRef.current.on("host-disconnected", () => {
      setNoHost(true);
    });

    return () => {
      clearTimeout(timeout);
      if (peerRef.current) {
        try { peerRef.current.close(); } catch (_) {}
        peerRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      // IMPROVEMENT: Reset flags on cleanup so reconnect works cleanly
      offerReceivedRef.current = false;
      pendingCandidatesRef.current = [];
    };
  }, [roomId, isUsernameSet]);

  /* Auto-scroll comments */
  useEffect(() => {
    if (commentsContainerRef.current) {
      commentsContainerRef.current.scrollTop = commentsContainerRef.current.scrollHeight;
    }
  }, [comments]);

  /* ---------- Manual Play ---------- */
  const startPlayback = async () => {
    try {
      if (videoRef.current) {
        videoRef.current.volume = volume;
        await videoRef.current.play();
        setCanPlay(true);
      }
    } catch (err) {
      console.error("Playback error:", err);
    }
  };

  /* ---------- Volume Control ---------- */
  const handleVolumeChange = (e) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
    }
  };

  /* ---------- Send Comment ---------- */
  const sendComment = (e) => {
    e.preventDefault();
    if (!commentText.trim() || !socketRef.current) return;
    socketRef.current.emit("send-comment", {
      roomId,
      username: username || "Anonymous",
      text: commentText
    });
    setCommentText("");
  };

  /* ---------- Set Username ---------- */
  const handleUsernameSubmit = (e) => {
    e.preventDefault();
    if (username.trim()) setIsUsernameSet(true);
  };

  /* ---------- Username Modal ---------- */
  if (!isUsernameSet) {
    return (
      <div style={styles.page}>
        <style>{keyframes}</style>
        <div style={styles.usernameModal}>
          <div style={styles.modalIcon}>🎬</div>
          <h2 style={styles.modalTitle}>Join Live Stream</h2>
          <p style={styles.modalSubtitle}>Enter your name to join the chat</p>
          <form onSubmit={handleUsernameSubmit}>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Your name..."
              style={styles.usernameInput}
              maxLength={20}
              autoFocus
            />
            <button
              type="submit"
              style={styles.modalButton}
              disabled={!username.trim()}
            >
              Join Stream 🚀
            </button>
          </form>
          <p style={styles.roomIdDisplay}>
            Room: <span style={{ color: "#38bdf8" }}>{roomId}</span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <style>{keyframes}</style>

      <div style={styles.mainContainer}>
        {/* Left Section - Video */}
        <div style={styles.leftSection}>
          <div style={styles.header}>
            <div style={styles.liveBadge}>
              <span style={styles.liveDot}></span>
              LIVE
            </div>
            <div style={styles.viewerBadge}>
              👥 {viewerCount} watching
            </div>
            <div style={styles.connectionStatus}>
              <span style={{
                color: connectionState === "connected" ? "#22c55e" :
                       connectionState === "connecting" ? "#f59e0b" : "#ef4444"
              }}>
                ● {connectionState}
              </span>
            </div>
          </div>

          <div style={styles.videoContainer}>
            {noHost ? (
              <div style={styles.noHostBox}>
                <div style={styles.noHostIcon}>📴</div>
                <h2 style={{ color: "#fff", marginTop: "20px" }}>Stream Ended</h2>
                <p style={{ color: "#94a3b8", marginTop: "10px" }}>The host has left the room</p>
                <button
                  style={styles.backButton}
                  onClick={() => window.history.back()}
                >
                  ← Go Back
                </button>
              </div>
            ) : (
              <>
                {isHostPaused && (
                  <div style={styles.pausedOverlay}>
                    <div style={styles.pausedIcon}>⏸️</div>
                    <h2 style={{ color: "#fff", marginTop: "20px" }}>Stream Paused</h2>
                    <p style={{ color: "#94a3b8" }}>Host will be back soon...</p>
                  </div>
                )}

                <video
                  ref={videoRef}
                  playsInline
                  autoPlay
                  muted={false}
                  controls={false}
                  style={styles.video}
                  onLoadedMetadata={() => {
                    console.log("Video metadata loaded");
                    if (pendingStreamRef.current && videoRef.current) {
                      videoRef.current.srcObject = pendingStreamRef.current;
                      pendingStreamRef.current = null;
                    }
                  }}
                  onCanPlay={() => console.log("Video can play")}
                />
                {!canPlay && connectionState !== "connected" && (
                  <div style={styles.loadingOverlay}>
                    <div style={styles.spinner}></div>
                    <p style={{ color: "#fff", marginTop: "20px" }}>Connecting to stream...</p>
                  </div>
                )}
                {connectionState === "connected" && !canPlay && (
                  <button style={styles.playButton} onClick={startPlayback}>
                    🔊 Click to Start Watching
                  </button>
                )}
              </>
            )}
          </div>

          {canPlay && !noHost && (
            <div style={styles.controls}>
              <div style={styles.volumeControl}>
                <span style={{ color: "#94a3b8", fontSize: "16px" }}>
                  {volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
                </span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={handleVolumeChange}
                  style={styles.volumeSlider}
                />
                <span style={{ color: "#94a3b8", fontSize: "14px", minWidth: "45px" }}>
                  {Math.round(volume * 100)}%
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Right Section - Comments */}
        <div style={styles.rightSection}>
          <div style={styles.commentsCard}>
            <div style={styles.commentHeader}>
              <h3 style={styles.commentsTitle}>💬 Live Chat</h3>
              <span style={styles.usernameDisplay}>as {username}</span>
            </div>

            <div ref={commentsContainerRef} style={styles.commentsContainer}>
              {comments.length === 0 ? (
                <p style={styles.noComments}>No messages yet. Be the first to chat!</p>
              ) : (
                // IMPROVEMENT: Stable composite key — comment.id doesn't exist in server schema
                comments.map((comment, index) => (
                  <div
                    key={`${comment.timestamp}-${comment.username}-${index}`}
                    style={{
                      ...styles.commentItem,
                      ...(comment.username === username ? styles.myComment : {})
                    }}
                  >
                    <span style={styles.commentUsername}>{comment.username}:</span>
                    <span style={styles.commentText}>{comment.text}</span>
                  </div>
                ))
              )}
            </div>

            <form onSubmit={sendComment} style={styles.commentForm}>
              <input
                type="text"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="Send a message..."
                style={styles.commentInput}
                maxLength={200}
              />
              <button
                type="submit"
                style={{
                  ...styles.sendButton,
                  ...(commentText.trim() ? {} : styles.sendButtonDisabled)
                }}
                disabled={!commentText.trim()}
              >
                ➤
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Keyframes ---------------- */
const keyframes = `
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  @keyframes slideIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  @keyframes scaleIn {
    from { opacity: 0; transform: scale(0.9); }
    to { opacity: 1; transform: scale(1); }
  }
`;

/* ---------------- Styles ---------------- */
const styles = {
  page: { minHeight: "100vh", background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #020617 100%)", display: "flex", alignItems: "flex-start", justifyContent: "center", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", padding: "20px" },
  mainContainer: { display: "flex", gap: "20px", width: "100%", maxWidth: "1600px", flexWrap: "wrap" },
  leftSection: { flex: "1 1 800px", minWidth: "300px" },
  rightSection: { flex: "0 0 350px", minWidth: "300px" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "10px", padding: "16px 24px", backgroundColor: "#0b1220", borderRadius: "16px", boxShadow: "0 10px 40px rgba(0,0,0,0.5)", animation: "fadeIn 0.5s ease" },
  liveBadge: { display: "flex", alignItems: "center", gap: "8px", backgroundColor: "#7f1d1d", padding: "8px 16px", borderRadius: "20px", fontSize: "13px", fontWeight: "600", color: "#fff", letterSpacing: "1px" },
  viewerBadge: { backgroundColor: "rgba(56, 189, 248, 0.2)", padding: "8px 16px", borderRadius: "20px", fontSize: "13px", fontWeight: "600", color: "#38bdf8", border: "1px solid rgba(56, 189, 248, 0.3)" },
  liveDot: { width: "10px", height: "10px", borderRadius: "50%", backgroundColor: "#ef4444", animation: "pulse 2s infinite" },
  connectionStatus: { fontSize: "13px", fontWeight: "500" },
  videoContainer: {
  position: "relative",
  width: "100%",
  aspectRatio: "16 / 9",
  backgroundColor: "#000",
  borderRadius: "20px",
  overflow: "hidden",
  boxShadow: "0 30px 80px rgba(0,0,0,0.8)",
},
  video: {
  width: "100%",
  height: "100%",
  objectFit: "cover",   // 🔥 important change
  maxHeight: "100%"
},
  pausedOverlay: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", backgroundColor: "rgba(0,0,0,0.9)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 10, animation: "fadeIn 0.3s ease" },
  pausedIcon: { fontSize: "80px", animation: "pulse 2s infinite" },
 loadingOverlay: {
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
  backgroundColor: "rgba(0,0,0,0.7)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 5,
},
  spinner: { width: "50px", height: "50px", border: "5px solid rgba(255,255,255,0.2)", borderTop: "5px solid #38bdf8", borderRadius: "50%", animation: "spin 1s linear infinite" },
  noHostBox: { textAlign: "center", padding: "40px" },
  noHostIcon: { fontSize: "80px" },
  backButton: { marginTop: "24px", padding: "12px 28px", borderRadius: "12px", border: "none", cursor: "pointer", fontWeight: "600", fontSize: "15px", background: "linear-gradient(135deg, #38bdf8, #0ea5e9)", color: "#fff", boxShadow: "0 8px 20px rgba(56,189,248,0.4)", transition: "transform 0.2s ease" },
  playButton: {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  padding: "18px 36px",
  borderRadius: "14px",
  border: "none",
  cursor: "pointer",
  fontWeight: "600",
  fontSize: "18px",
  background: "linear-gradient(135deg, #38bdf8, #0ea5e9)",
  color: "#fff",
  boxShadow: "0 15px 40px rgba(56,189,248,0.6)",
  zIndex: 6,
},
  controls: { marginTop: "20px", display: "flex", justifyContent: "center", animation: "slideIn 0.5s ease" },
  volumeControl: { display: "flex", alignItems: "center", gap: "15px", backgroundColor: "#0b1220", padding: "16px 24px", borderRadius: "16px", boxShadow: "0 10px 40px rgba(0,0,0,0.5)" },
  volumeSlider: { width: "180px", height: "6px", borderRadius: "3px", outline: "none", background: "linear-gradient(to right, #38bdf8, #0ea5e9)", cursor: "pointer" },
  commentsCard: { backgroundColor: "#0b1220", padding: "24px", borderRadius: "20px", boxShadow: "0 25px 70px rgba(0,0,0,0.7)", height: "calc(100vh - 40px)", display: "flex", flexDirection: "column", animation: "fadeIn 0.5s ease" },
  commentHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", paddingBottom: "12px", borderBottom: "1px solid rgba(255,255,255,0.1)" },
  commentsTitle: { fontSize: "20px", fontWeight: "600", color: "#e2e8f0" },
  usernameDisplay: { fontSize: "12px", color: "#64748b", fontStyle: "italic" },
  commentsContainer: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "10px", paddingRight: "8px", marginBottom: "16px" },
  noComments: { color: "#64748b", textAlign: "center", fontSize: "14px", marginTop: "40px" },
  commentItem: { backgroundColor: "rgba(56, 189, 248, 0.1)", padding: "12px 14px", borderRadius: "12px", borderLeft: "3px solid #38bdf8", animation: "slideIn 0.3s ease", wordWrap: "break-word" },
  myComment: { backgroundColor: "rgba(129, 140, 248, 0.15)", borderLeft: "3px solid #818cf8" },
  commentUsername: { fontWeight: "700", color: "#38bdf8", marginRight: "8px", fontSize: "13px" },
  commentText: { color: "#e2e8f0", fontSize: "14px", lineHeight: "1.5" },
  commentForm: { display: "flex", gap: "10px" },
  commentInput: { flex: 1, padding: "14px 16px", borderRadius: "12px", border: "1px solid rgba(56, 189, 248, 0.3)", backgroundColor: "rgba(56, 189, 248, 0.05)", color: "#e2e8f0", fontSize: "14px", outline: "none", transition: "all 0.3s ease" },
  sendButton: { padding: "14px 20px", borderRadius: "12px", border: "none", background: "linear-gradient(135deg, #38bdf8, #0ea5e9)", color: "#fff", fontSize: "18px", cursor: "pointer", fontWeight: "600", boxShadow: "0 8px 20px rgba(56,189,248,0.4)", transition: "all 0.2s ease" },
  sendButtonDisabled: { opacity: 0.5, cursor: "not-allowed", boxShadow: "none" },
  usernameModal: { backgroundColor: "#0b1220", padding: "50px 40px", borderRadius: "24px", boxShadow: "0 30px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.05)", textAlign: "center", maxWidth: "450px", width: "90%", animation: "scaleIn 0.5s ease" },
  modalIcon: { fontSize: "60px", marginBottom: "20px" },
  modalTitle: { fontSize: "32px", fontWeight: "700", color: "#e2e8f0", marginBottom: "10px", background: "linear-gradient(135deg, #38bdf8, #818cf8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" },
  modalSubtitle: { fontSize: "15px", color: "#94a3b8", marginBottom: "30px" },
  usernameInput: { width: "100%", padding: "18px 20px", borderRadius: "12px", border: "2px solid rgba(56, 189, 248, 0.3)", backgroundColor: "rgba(56, 189, 248, 0.05)", color: "#e2e8f0", fontSize: "16px", outline: "none", marginBottom: "20px", transition: "all 0.3s ease", textAlign: "center", boxSizing: "border-box" },
  modalButton: { width: "100%", padding: "18px", borderRadius: "12px", border: "none", background: "linear-gradient(135deg, #38bdf8, #0ea5e9)", color: "#fff", fontSize: "16px", fontWeight: "600", cursor: "pointer", boxShadow: "0 10px 30px rgba(56,189,248,0.5)", transition: "all 0.2s ease" },
  roomIdDisplay: { marginTop: "20px", fontSize: "13px", color: "#64748b" },
};