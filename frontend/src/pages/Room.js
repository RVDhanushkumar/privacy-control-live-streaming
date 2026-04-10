import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import io from "socket.io-client";
import Peer from "simple-peer";

const socket = io("https://privacy-control-live-streaming-1.onrender.com", {
  transports: ["websocket"],
});


export default function Room() {
  const { roomId } = useParams();
  const myVideo = useRef();
  const peersRef = useRef([]);
  const [peers, setPeers] = useState([]);

  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then(stream => {
        myVideo.current.srcObject = stream;
        socket.emit("join-room", roomId);

        socket.on("all-users", users => {
          const peersArr = [];
          users.forEach(userId => {
            const peer = createPeer(userId, stream);
            peersRef.current.push({ peerID: userId, peer });
            peersArr.push(peer);
          });
          setPeers(peersArr);
        });

        socket.on("user-joined", userId => {
          const peer = addPeer(userId, stream);
          peersRef.current.push({ peerID: userId, peer });
          setPeers(users => [...users, peer]);
        });

        socket.on("user-signal", payload => {
          const peer = addPeer(payload.callerId, stream);
          peer.signal(payload.signal);
          peersRef.current.push({ peerID: payload.callerId, peer });
          setPeers(users => [...users, peer]);
        });

        socket.on("signal-returned", payload => {
          const peerObj = peersRef.current.find(p => p.peerID === payload.id);
          peerObj.peer.signal(payload.signal);
        });

        socket.on("user-left", id => {
          const peerObj = peersRef.current.find(p => p.peerID === id);
          peerObj?.peer.destroy();
          setPeers(peers => peers.filter(p => p !== peerObj?.peer));
        });
      });
  }, [roomId]);

  function createPeer(userId, stream) {
    const peer = new Peer({ initiator: true, trickle: false, stream });
    peer.on("signal", signal => {
      socket.emit("sending-signal", { userToSignal: userId, signal });
    });
    return peer;
  }

  function addPeer(userId, stream) {
    const peer = new Peer({ initiator: false, trickle: false, stream });
    peer.on("signal", signal => {
      socket.emit("returning-signal", { callerId: userId, signal });
    });
    return peer;
  }

  return (
    <div>
      <h2>Room: {roomId}</h2>
      <video ref={myVideo} autoPlay muted style={{ width: 300 }} />
      {peers.map((peer, i) => (
        <Video key={i} peer={peer} />
      ))}
    </div>
  );
}

function Video({ peer }) {
  const ref = useRef();
  useEffect(() => {
    peer.on("stream", stream => (ref.current.srcObject = stream));
  }, []);
  return <video ref={ref} autoPlay style={{ width: 300 }} />;
}
