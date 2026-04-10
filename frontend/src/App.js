import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Login from "./pages/Login.js";
import Dashboard from "./pages/Dashboard";
import LiveStream from "./pages/LiveStream";
import ViewerStream from "./pages/ViewerStream.js";
import Signup from "./pages/signup.js";

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/live" element={<LiveStream />} />
        <Route path="/join" element={<ViewerStream />} />
      </Routes>
    </Router>
  );
}

export default App;
