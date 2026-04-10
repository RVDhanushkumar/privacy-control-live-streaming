import { useEffect, useState } from "react";
import * as faceapi from "face-api.js";

export default function useFaceModels() {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const load = async () => {
      const url = "/models";
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(url),
        faceapi.nets.faceLandmark68Net.loadFromUri(url),
      ]);
      setLoaded(true);
    };
    load();
  }, []);

  return loaded;
}
