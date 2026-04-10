import { useNavigate } from "react-router-dom";
import { Video, ShieldCheck, Settings, X } from "lucide-react";
import { useState } from "react";
import "../styles/dashboard.css";

export default function Dashboard() {
  const navigate = useNavigate();
  const [showModal, setShowModal] = useState(false);
  const [roomId, setRoomId] = useState("");

  const handleNavigate = (role) => {
    if (!roomId.trim()) {
      alert("Please enter a Room ID");
      return;
    }

    navigate(`/${role}?room=${roomId}`);
  };

  return (
    <div className="dash-page">
      {/* Navbar */}
      <header className="dash-navbar">
        <h2 className="brand" onClick={() => navigate("/")}>
          PrivStream
        </h2>
        <div className="profile">
          <div className="avatar">DK</div>
          <span>Creator</span>
        </div>
      </header>

      {/* Content */}
      <div className="dash-content">
        <h1 className="dash-title">Streaming Studio</h1>
        <p className="dash-subtitle">
          Manage your privacy-protected live streams powered by AI
        </p>

        <div className="dash-grid">
          <div className="dash-card highlight">
            <Video size={36} />
            <h3>Start Live Stream</h3>
            <p>Go live with automatic face recognition & privacy blur.</p>
            <button onClick={() => setShowModal(true)}>
              Go Live
            </button>
          </div>

          <div className="dash-card">
            <ShieldCheck size={32} />
            <h3>Privacy Protection</h3>
            <p>
              Unknown faces are blurred in real-time while registered users stay visible.
            </p>
          </div>

          <div className="dash-card">
            <Settings size={32} />
            <h3>Stream Settings</h3>
            <p>Configure camera, mic, and recognition sensitivity.</p>
          </div>
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h3>Go Live</h3>
              <X size={20} onClick={() => setShowModal(false)} />
            </div>

            <input
              type="text"
              placeholder="Enter Room ID"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
            />

            <div className="modal-buttons">
              <button
                className="host-btn"
                onClick={() => handleNavigate("live")}
              >
                Host Stream
              </button>

              <button
                className="join-btn"
                onClick={() => handleNavigate("join")}
              >
                Join Stream
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
