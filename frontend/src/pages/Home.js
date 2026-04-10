import { useNavigate } from "react-router-dom";
import  "../styles/home.css";

export default function Home() {
  const navigate = useNavigate();

  return (
    <div className="home">
      {/* ---------- NAVBAR ---------- */}
      <nav className="nav">
        <h2 className="logo">PrivStream</h2>
        <div className="nav-actions">
          <button className="nav-btn" onClick={() => navigate("/login")}>
            Login
          </button>
          <button className="nav-btn primary" onClick={() => navigate("/login")}>
            Start Streaming
          </button>
        </div>
      </nav>

      {/* ---------- HERO SECTION ---------- */}
      <section className="hero">
        <div className="hero-content">
          <h1>AI-Powered Privacy for Live Streaming</h1>
          <p>
            PrivStream uses real-time face recognition to automatically blur
            unknown faces while you stream — keeping your content safe,
            compliant, and privacy-first.
          </p>
          <div className="hero-buttons">
            <button className="primary large" onClick={() => navigate("/login")}>
              Get Started Free
            </button>
            <button className="secondary" onClick={() => navigate("/login")}>
              Watch Demo
            </button>
          </div>
        </div>
      </section>

      {/* ---------- FEATURES ---------- */}
      <section className="features">
        <h2>Why Choose PrivStream?</h2>
        <div className="feature-grid">
          <div className="feature-card">
            <h3>🎯 Real-Time Face Detection</h3>
            <p>
              Detects and processes faces instantly without interrupting your
              live stream.
            </p>
          </div>

          <div className="feature-card">
            <h3>🔒 Automatic Privacy Protection</h3>
            <p>
              Unknown individuals are blurred automatically to protect identity
              and comply with privacy standards.
            </p>
          </div>

          <div className="feature-card">
            <h3>⚡ AI Powered Recognition</h3>
            <p>
              Register trusted faces and let AI distinguish them from others in
              real-time.
            </p>
          </div>

          <div className="feature-card">
            <h3>🌐 Stream Anywhere</h3>
            <p>
              Works seamlessly with webcams and streaming software for a smooth
              live experience.
            </p>
          </div>
        </div>
      </section>

      {/* ---------- CTA SECTION ---------- */}
      <section className="cta">
        <h2>Start Streaming with Privacy Today</h2>
        <p>No complex setup. Just smart AI protecting your stream.</p>
        <button className="primary large" onClick={() => navigate("/login")}>
          Launch PrivStream
        </button>
      </section>

      {/* ---------- FOOTER ---------- */}
      <footer className="footer">
        © {new Date().getFullYear()} PrivStream. AI Privacy Streaming Platform.
      </footer>
    </div>
  );
}
