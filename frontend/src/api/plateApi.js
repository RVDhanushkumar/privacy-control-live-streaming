import axios from "axios";

export const detectPlates = (image) =>
  axios.post("http://localhost:5000/detect-plates", { image });
