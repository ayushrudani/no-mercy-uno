/**
 * Voice chat: a peer-to-peer audio mesh.
 *
 * Every participant holds one RTCPeerConnection per other participant. At six
 * players that is five up and five down, which is fine for audio on a phone and
 * costs the server nothing but the signalling handshake -- the audio itself
 * never touches it. An SFU would be the answer above roughly ten people; this
 * game caps at eight.
 *
 * Negotiation uses the "perfect negotiation" pattern. Two people joining at the
 * same moment can both try to offer, and without a deterministic tie-break that
 * collision leaves a connection wedged in `have-local-offer` forever. The
 * politeness rule is derived from the two user ids, so both sides always agree
 * on who yields without exchanging an extra message.
 */

export interface PeerState {
  userId: string;
  stream: MediaStream | null;
  connection: RTCPeerConnectionState;
  /** 0..1 short-term loudness, for the speaking ring. */
  level: number;
  /** Local playback volume, 0..1. Does not affect anyone else. */
  volume: number;
}

export interface VoiceSignals {
  sendOffer(to: string, sdp: string): void;
  sendAnswer(to: string, sdp: string): void;
  sendIce(to: string, candidate: string): void;
  reportMic(micOn: boolean): void;
}

export interface VoiceCallbacks {
  onPeersChanged(peers: PeerState[]): void;
  onLevels(levels: Record<string, number>): void;
  onError(message: string): void;
}

interface Peer {
  userId: string;
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  audio: HTMLAudioElement;
  analyser: AnalyserNode | null;
  source: MediaStreamAudioSourceNode | null;
  level: number;
  volume: number;
  /** Perfect-negotiation bookkeeping. */
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** Queued candidates that arrived before the remote description. */
  pendingCandidates: RTCIceCandidateInit[];
}

const LEVEL_INTERVAL_MS = 120;
/** RMS below this is treated as silence, so background hiss is not "speaking". */
const SILENCE_FLOOR = 0.012;

export class VoiceEngine {
  private myId = '';
  private local: MediaStream | null = null;
  private readonly peers = new Map<string, Peer>();
  private iceServers: RTCIceServer[] = [];
  private audioCtx: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private speakerOn = true;
  private micOn = false;
  private active = false;

  constructor(
    private readonly signals: VoiceSignals,
    private readonly callbacks: VoiceCallbacks,
  ) {}

  get isActive(): boolean {
    return this.active;
  }
  get isMicOn(): boolean {
    return this.micOn;
  }
  get isSpeakerOn(): boolean {
    return this.speakerOn;
  }

  /**
   * Request the microphone and prepare to connect.
   *
   * Called from the waiting room rather than mid-game: a browser permission
   * prompt appearing while a turn clock is running is a good way to lose a hand.
   */
  async start(myId: string, iceServers: RTCIceServer[]): Promise<void> {
    this.myId = myId;
    this.iceServers = iceServers;

    try {
      this.local = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (err) {
      const name = (err as Error).name;
      this.callbacks.onError(
        name === 'NotAllowedError'
          ? 'Microphone permission denied.'
          : name === 'NotFoundError'
            ? 'No microphone found.'
            : `Could not open the microphone: ${(err as Error).message}`,
      );
      throw err;
    }

    this.active = true;
    this.setMicEnabled(true);
    this.startLevelMonitor();
  }

  /** Peers already on the call; we send each of them an offer. */
  async connectTo(userIds: string[]): Promise<void> {
    for (const id of userIds) {
      if (id === this.myId) continue;
      const peer = this.ensurePeer(id);
      await this.makeOffer(peer);
    }
    this.emitPeers();
  }

  setMicEnabled(on: boolean): void {
    this.micOn = on;
    // Disabling the track keeps the connection up and the negotiation stable;
    // removing it would force a renegotiation on every mute press.
    for (const track of this.local?.getAudioTracks() ?? []) track.enabled = on;
    this.signals.reportMic(on);
  }

  /** Speaker mute is purely local: nobody else can tell. */
  setSpeakerEnabled(on: boolean): void {
    this.speakerOn = on;
    for (const peer of this.peers.values()) {
      peer.audio.muted = !on;
    }
  }

  setPeerVolume(userId: string, volume: number): void {
    const peer = this.peers.get(userId);
    if (!peer) return;
    peer.volume = Math.max(0, Math.min(1, volume));
    peer.audio.volume = peer.volume;
    this.emitPeers();
  }

  /** Someone left the call or the room. */
  removePeer(userId: string): void {
    const peer = this.peers.get(userId);
    if (!peer) return;
    peer.pc.close();
    peer.audio.srcObject = null;
    peer.audio.remove();
    peer.source?.disconnect();
    this.peers.delete(userId);
    this.emitPeers();
  }

  stop(): void {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    for (const track of this.local?.getTracks() ?? []) track.stop();
    this.local = null;
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    void this.audioCtx?.close();
    this.audioCtx = null;
    this.localAnalyser = null;
    this.active = false;
    this.micOn = false;
    this.signals.reportMic(false);
    this.emitPeers();
  }

  // -- signalling handlers ---------------------------------------------------

  async onOffer(from: string, sdp: string): Promise<void> {
    const peer = this.ensurePeer(from);
    const description = JSON.parse(sdp) as RTCSessionDescriptionInit;

    // Perfect negotiation: on a collision the impolite peer ignores the offer
    // and keeps its own; the polite peer rolls back and accepts.
    const collision = peer.makingOffer || peer.pc.signalingState !== 'stable';
    peer.ignoreOffer = !this.isPolite(from) && collision;
    if (peer.ignoreOffer) return;

    try {
      await peer.pc.setRemoteDescription(description);
      await this.flushCandidates(peer);
      await peer.pc.setLocalDescription();
      if (peer.pc.localDescription) {
        this.signals.sendAnswer(from, JSON.stringify(peer.pc.localDescription));
      }
    } catch (err) {
      this.callbacks.onError(`Voice handshake failed: ${(err as Error).message}`);
    }
  }

  async onAnswer(from: string, sdp: string): Promise<void> {
    const peer = this.peers.get(from);
    if (!peer) return;
    try {
      await peer.pc.setRemoteDescription(JSON.parse(sdp) as RTCSessionDescriptionInit);
      await this.flushCandidates(peer);
    } catch (err) {
      this.callbacks.onError(`Voice handshake failed: ${(err as Error).message}`);
    }
  }

  async onIce(from: string, candidate: string): Promise<void> {
    const peer = this.peers.get(from);
    if (!peer) return;
    const init = JSON.parse(candidate) as RTCIceCandidateInit;

    // Candidates can outrun the description they belong to; hold them.
    if (!peer.pc.remoteDescription) {
      peer.pendingCandidates.push(init);
      return;
    }
    try {
      await peer.pc.addIceCandidate(init);
    } catch (err) {
      if (!peer.ignoreOffer) {
        this.callbacks.onError(`Voice candidate rejected: ${(err as Error).message}`);
      }
    }
  }

  // -- internals -------------------------------------------------------------

  private isPolite(peerId: string): boolean {
    return isPolitePeer(this.myId, peerId);
  }

  private ensurePeer(userId: string): Peer {
    const existing = this.peers.get(userId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = !this.speakerOn;
    // Off-screen but in the document: some browsers will not play a stream
    // attached to a detached element.
    audio.style.display = 'none';
    document.body.appendChild(audio);

    const peer: Peer = {
      userId,
      pc,
      stream: null,
      audio,
      analyser: null,
      source: null,
      level: 0,
      volume: 1,
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
    };

    for (const track of this.local?.getTracks() ?? []) {
      pc.addTrack(track, this.local!);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) this.signals.sendIce(userId, JSON.stringify(e.candidate));
    };

    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      peer.stream = stream;
      peer.audio.srcObject = stream;
      peer.audio.volume = peer.volume;
      void peer.audio.play().catch(() => {
        // Autoplay can still be blocked; the next user gesture will start it.
      });
      this.attachAnalyser(peer, stream);
      this.emitPeers();
    };

    pc.onnegotiationneeded = () => {
      void this.makeOffer(peer);
    };

    pc.onconnectionstatechange = () => {
      this.emitPeers();
      if (pc.connectionState === 'failed') {
        // An ICE restart is the standard recovery, and is usually what rescues
        // a connection when someone switches from wifi to mobile data.
        void this.makeOffer(peer, true);
      }
    };

    this.peers.set(userId, peer);
    return peer;
  }

  private async makeOffer(peer: Peer, iceRestart = false): Promise<void> {
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription(
        iceRestart ? await peer.pc.createOffer({ iceRestart: true }) : undefined,
      );
      if (peer.pc.localDescription) {
        this.signals.sendOffer(peer.userId, JSON.stringify(peer.pc.localDescription));
      }
    } catch (err) {
      this.callbacks.onError(`Voice offer failed: ${(err as Error).message}`);
    } finally {
      peer.makingOffer = false;
    }
  }

  private async flushCandidates(peer: Peer): Promise<void> {
    const queued = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const c of queued) {
      try {
        await peer.pc.addIceCandidate(c);
      } catch {
        /* a stale candidate after renegotiation is not fatal */
      }
    }
  }

  // -- speaking levels -------------------------------------------------------

  private ctx(): AudioContext | null {
    if (this.audioCtx) return this.audioCtx;
    try {
      const Ctor =
        window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.audioCtx = new Ctor();
    } catch {
      return null;
    }
    return this.audioCtx;
  }

  private attachAnalyser(peer: Peer, stream: MediaStream): void {
    const ctx = this.ctx();
    if (!ctx) return;
    try {
      peer.source?.disconnect();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      // Not connected to destination: the <audio> element does the playing.
      // Connecting here as well would double every voice.
      source.connect(analyser);
      peer.source = source;
      peer.analyser = analyser;
    } catch {
      /* level meters are cosmetic; failure here must not break audio */
    }
  }

  private startLevelMonitor(): void {
    const ctx = this.ctx();
    if (ctx && this.local) {
      try {
        const source = ctx.createMediaStreamSource(this.local);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        this.localAnalyser = analyser;
      } catch {
        /* ignore */
      }
    }

    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = setInterval(() => {
      const levels: Record<string, number> = {};

      if (this.localAnalyser && this.micOn) {
        levels[this.myId] = rms(this.localAnalyser);
      } else {
        levels[this.myId] = 0;
      }

      for (const peer of this.peers.values()) {
        peer.level = peer.analyser ? rms(peer.analyser) : 0;
        levels[peer.userId] = peer.level;
      }

      this.callbacks.onLevels(levels);
    }, LEVEL_INTERVAL_MS);
  }

  private emitPeers(): void {
    this.callbacks.onPeersChanged(
      [...this.peers.values()].map((p) => ({
        userId: p.userId,
        stream: p.stream,
        connection: p.pc.connectionState,
        level: p.level,
        volume: p.volume,
      })),
    );
  }
}

/**
 * Which side yields when both peers offer at once.
 *
 * Derived from the two ids alone, so both ends compute the same answer without
 * exchanging a message. It must be exactly asymmetric: if both sides thought
 * they were polite they would both roll back and neither would ever connect,
 * and if both thought they were impolite each would ignore the other's offer
 * and the connection would stay wedged in `have-local-offer`.
 */
export function isPolitePeer(myId: string, peerId: string): boolean {
  return myId > peerId;
}

/** Root-mean-square of the current waveform, normalised to roughly 0..1. */
function rms(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i]! - 128) / 128;
    sum += v * v;
  }
  const value = Math.sqrt(sum / data.length);
  return value < SILENCE_FLOOR ? 0 : Math.min(1, value * 4);
}

export { rms as rmsForTesting, SILENCE_FLOOR };
