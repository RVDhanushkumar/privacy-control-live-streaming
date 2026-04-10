import React, { useEffect, useRef } from "react";
import * as faceapi from "face-api.js";

export default function FaceStream({ stream, isLocal }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    video.srcObject = stream;

    const playVideo = async () => {
      try {
        await video.play();
      } catch {}
    };
    playVideo();

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    const detectFaces = async () => {
      if (!video || video.readyState !== 4) {
        requestAnimationFrame(detectFaces);
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const detections = await faceapi
        .detectAllFaces(video)
        .withFaceLandmarks()
        .withFaceDescriptors();

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      detections.forEach((det) => {
        const { x, y, width, height } = det.detection.box;

        ctx.save();
        ctx.beginPath();
        ctx.ellipse(
          x + width / 2,
          y + height / 2,
          width / 2,
          height / 2,
          0,
          0,
          Math.PI * 2
        );
        ctx.clip();
        ctx.filter = "blur(25px)";
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        ctx.restore();
      });

      requestAnimationFrame(detectFaces);
    };

    detectFaces();
  }, [stream]);

  return (
    <div style={{ position: "relative" }}>
      <video
        ref={videoRef}
        autoPlay
        muted={isLocal}
        style={{ width: "300px", borderRadius: "10px" }}
      />
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "300px",
          borderRadius: "10px",
        }}
      />
    </div>
  );
}
