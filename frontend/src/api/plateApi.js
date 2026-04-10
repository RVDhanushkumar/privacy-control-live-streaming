import axios from "axios";

export const detectPlates = (image) =>
  axios.post("https://privacy-control-live-streaming-1.onrender.com/detect-plates", { image });
