import React from "react";
import FaceStream from "./FaceStream";

export default function VideoGrid({ streams }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
        gap: "10px",
      }}
    >
      {streams.map((s) => (
        <FaceStream key={s.id} stream={s.stream} isLocal={s.isLocal} />
      ))}
    </div>
  );
}
