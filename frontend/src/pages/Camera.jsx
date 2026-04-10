import Webcam from "react-webcam";

export default function Camera({ webcamRef }) {
  return (
    <Webcam
      ref={webcamRef}
      mirrored
      screenshotFormat="image/jpeg"
      style={{ width: "100%" }}
    />
  );
}
