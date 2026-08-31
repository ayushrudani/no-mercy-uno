/**
 * Sound effects, synthesised at runtime with Web Audio.
 *
 * No audio files: the whole set is a few oscillators and noise bursts, which
 * means nothing to download, nothing to cache, no CDN, and it works offline.
 * A card flip is a filtered noise burst; a Draw 10 is a detuned low thud. That
 * is genuinely all these need to be.
 *
 * Browsers refuse to start audio before a user gesture, so `unlock()` is called
 * from the first real interaction and everything before that is a silent no-op.
 */

export type SoundName =
  | 'flip'      // a card leaves a hand
  | 'draw'      // a card is taken
  | 'deal'      // a round is dealt
  | 'turn'      // your turn begins
  | 'stack'     // a draw stack grows
  | 'slam'      // a big draw card lands
  | 'skip'      // someone is skipped
  | 'reverse'   // direction flips
  | 'shuffle'   // the pile is recycled
  | 'eliminate' // a player hits 25
  | 'round'     // a round ends
  | 'swap'      // hands change owner under the 7-0 rule
  | 'uno'       // somebody called it
  | 'win';      // the game ends

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;
  private volume = 0.7;

  /** Safe to call repeatedly; only the first gesture actually opens the context. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
    } catch {
      // No audio available. Everything below degrades to silence.
      this.ctx = null;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.volume;
  }

  setVolume(volume0to100: number): void {
    this.volume = Math.max(0, Math.min(1, volume0to100 / 100));
    if (this.master && !this.muted) this.master.gain.value = this.volume;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  // -- primitives ----------------------------------------------------------

  /** A single enveloped oscillator. `to` sweeps the pitch when given. */
  private tone(opts: {
    freq: number;
    to?: number;
    dur: number;
    type?: OscillatorType;
    gain?: number;
    delay?: number;
  }): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), t0 + opts.dur);

    // Short attack, exponential decay: percussive without clicking.
    const peak = opts.gain ?? 0.3;
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);

    osc.connect(env).connect(master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.02);
  }

  /** Band-passed white noise -- the papery part of a card sound. */
  private noise(opts: { dur: number; freq: number; q?: number; gain?: number; delay?: number }): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const frames = Math.max(1, Math.floor(ctx.sampleRate * opts.dur));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = opts.freq;
    filter.Q.value = opts.q ?? 1;

    const env = ctx.createGain();
    env.gain.setValueAtTime(opts.gain ?? 0.2, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);

    src.connect(filter).connect(env).connect(master);
    src.start(t0);
    src.stop(t0 + opts.dur);
  }

  // -- the kit -------------------------------------------------------------

  play(name: SoundName): void {
    if (!this.ctx || this.muted) return;

    switch (name) {
      case 'flip':
        this.noise({ dur: 0.09, freq: 2400, q: 0.8, gain: 0.22 });
        this.tone({ freq: 320, to: 180, dur: 0.07, type: 'triangle', gain: 0.12 });
        break;

      case 'draw':
        this.noise({ dur: 0.13, freq: 1300, q: 0.6, gain: 0.16 });
        break;

      case 'deal':
        // Seven quick riffles, one per card.
        for (let i = 0; i < 7; i++) {
          this.noise({ dur: 0.07, freq: 2000 + i * 90, q: 0.9, gain: 0.13, delay: i * 0.075 });
        }
        break;

      case 'turn':
        this.tone({ freq: 660, dur: 0.13, type: 'sine', gain: 0.2 });
        this.tone({ freq: 990, dur: 0.18, type: 'sine', gain: 0.16, delay: 0.1 });
        break;

      case 'stack':
        this.tone({ freq: 400, to: 760, dur: 0.2, type: 'sawtooth', gain: 0.14 });
        break;

      case 'slam':
        // Low detuned pair plus a noise crack: this is the "you are in trouble" sound.
        this.tone({ freq: 150, to: 55, dur: 0.42, type: 'square', gain: 0.3 });
        this.tone({ freq: 78, to: 40, dur: 0.5, type: 'sine', gain: 0.28 });
        this.noise({ dur: 0.2, freq: 900, q: 0.5, gain: 0.22 });
        break;

      case 'skip':
        this.tone({ freq: 240, to: 120, dur: 0.16, type: 'square', gain: 0.2 });
        break;

      case 'reverse':
        this.tone({ freq: 300, to: 900, dur: 0.12, type: 'triangle', gain: 0.18 });
        this.tone({ freq: 900, to: 300, dur: 0.14, type: 'triangle', gain: 0.18, delay: 0.11 });
        break;

      case 'shuffle':
        for (let i = 0; i < 10; i++) {
          this.noise({ dur: 0.05, freq: 1500 + Math.random() * 1600, q: 1.4, gain: 0.1, delay: i * 0.035 });
        }
        break;

      case 'eliminate':
        // Descending minor third, twice: a small funeral.
        this.tone({ freq: 440, to: 220, dur: 0.32, type: 'sawtooth', gain: 0.24 });
        this.tone({ freq: 330, to: 110, dur: 0.5, type: 'sawtooth', gain: 0.2, delay: 0.22 });
        break;

      case 'swap':
        // Two tones crossing past each other: one hand going out, one coming in.
        this.tone({ freq: 480, to: 900, dur: 0.22, type: 'triangle', gain: 0.2 });
        this.tone({ freq: 900, to: 480, dur: 0.22, type: 'triangle', gain: 0.2 });
        this.noise({ dur: 0.12, freq: 1800, q: 0.7, gain: 0.14, delay: 0.16 });
        break;

      case 'uno':
        // Bright, rising, unmistakable -- it needs to cut across the table.
        this.tone({ freq: 880, dur: 0.1, type: 'square', gain: 0.18 });
        this.tone({ freq: 1320, dur: 0.16, type: 'square', gain: 0.16, delay: 0.09 });
        break;

      case 'round':
        this.tone({ freq: 523, dur: 0.14, gain: 0.2 });
        this.tone({ freq: 784, dur: 0.22, gain: 0.18, delay: 0.12 });
        break;

      case 'win': {
        // C-E-G-C arpeggio.
        const notes = [523, 659, 784, 1047];
        notes.forEach((f, i) =>
          this.tone({ freq: f, dur: 0.34, type: 'triangle', gain: 0.24, delay: i * 0.11 }),
        );
        break;
      }
    }
  }
}

export const sound = new SoundEngine();

const MUTE_KEY = 'nmu.muted';

export function loadMutePreference(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveMutePreference(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* private mode: the preference just will not persist */
  }
}
