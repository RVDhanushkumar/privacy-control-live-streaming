import { useNavigate } from "react-router-dom";
import { useState, useRef, useEffect } from "react";
import * as faceapi from "face-api.js";
import "../styles/login.css";

export default function Signup() {
  const navigate = useNavigate();
  const videoRef = useRef(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [faceDescriptor, setFaceDescriptor] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);

  // Load face models
  useEffect(() => {
    const loadModels = async () => {
      const MODEL_URL = "https://privacy-stream.vercel.app/models"; // place models in public/models
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
      await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    };
    loadModels();
  }, []);

  // Start camera
  const startCamera = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    videoRef.current.srcObject = stream;
    setCameraReady(true);
  };

  // Capture face
  const captureFace = async () => {
    if (!videoRef.current) return;

    const detection = await faceapi
      .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      setError("No face detected. Try again.");
      return;
    }

    const descriptorArray = Array.from(detection.descriptor);
    setFaceDescriptor(descriptorArray);
    setError("");
    alert("Face registered successfully!");
  };

  const handleSignup = async (e) => {
    e.preventDefault();

    if (!email || !password || !faceDescriptor) {
      setError("Fill all fields and register face.");
      return;
    }

    try {
      setLoading(true);

      const res = await fetch("https://privacy-control-live-streaming-1.onrender.com/api/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          password,
          faceDescriptor
        })
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message);
        setLoading(false);
        return;
      }

      alert("Signup successful!");
      navigate("/");

    } catch (err) {
      setError("Server error.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <div className="logo">🆕</div>
          <h2>Create Account</h2>
          <p>Register with face verification</p>
        </div>

        <form onSubmit={handleSignup} className="auth-form">
          <div className="input-group">
            <label>Email</label>
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="input-group">
            <label>Password</label>
            <input
              type="password"
              placeholder="Create password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <div className="input-group">
            {!cameraReady && (
              <button type="button" onClick={startCamera} className="auth-button">
                Start Camera
              </button>
            )}

            <video
              ref={videoRef}
              autoPlay
              muted
              width="100%"
              style={{ marginTop: "10px", borderRadius: "10px" }}
            />

            {cameraReady && (
              <button
                type="button"
                onClick={captureFace}
                className="auth-button"
                style={{ marginTop: "10px" }}
              >
                Register Face
              </button>
            )}
          </div>

          {error && <div className="error-text">{error}</div>}

          <button type="submit" className="auth-button" disabled={loading}>
            {loading ? "Signing up..." : "Sign Up"}
          </button>
        </form>

        <div className="auth-footer">
          Already have an account?{" "}
          <span onClick={() => navigate("/")} style={{ cursor: "pointer" }}>
            Login
          </span>
        </div>
      </div>
    </div>
  );
}