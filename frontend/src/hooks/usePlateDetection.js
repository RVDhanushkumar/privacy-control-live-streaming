import { useEffect, useState } from "react";
import { detectPlates } from "../api/plateApi";

export default function usePlateDetection(webcamRef) {
  const [plates, setPlates] = useState([]);

  useEffect(() => {
    const interval = setInterval(async () => {
      if (!webcamRef.current) return;
      const img = webcamRef.current.getScreenshot();
      if (!img) return;

      const res = await detectPlates(img);
      setPlates(res.data);
    }, 700);

    return () => clearInterval(interval);
  }, []);

  return plates;
}

