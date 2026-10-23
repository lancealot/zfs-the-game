/** Small synthesized sound effects. Nothing plays until the player interacts. */
export class Sound {
  enabled = true
  private ctx: AudioContext | null = null
  private master: GainNode | null = null

  private ensure(): AudioContext | null {
    if (!this.enabled) return null
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext()
        this.master = this.ctx.createGain()
        this.master.gain.value = 0.5
        this.master.connect(this.ctx.destination)
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return this.ctx
    } catch {
      return null
    }
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.05, slideTo?: number, delay = 0) {
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    const t = ctx.currentTime + delay
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t)
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(gain, t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(g).connect(this.master)
    osc.start(t)
    osc.stop(t + dur + 0.02)
  }

  private noise(dur: number, gain = 0.05, freq = 1800) {
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    const len = Math.floor(ctx.sampleRate * dur)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len)
    const src = ctx.createBufferSource()
    src.buffer = buf
    const filt = ctx.createBiquadFilter()
    filt.type = 'bandpass'
    filt.frequency.value = freq
    const g = ctx.createGain()
    g.gain.value = gain
    src.connect(filt).connect(g).connect(this.master)
    src.start()
  }

  click() {
    this.tone(720, 0.05, 'triangle', 0.025)
  }
  tick() {
    this.tone(1400, 0.03, 'square', 0.012)
  }
  write() {
    this.tone(980, 0.06, 'triangle', 0.03, 1320)
  }
  read() {
    this.tone(1320, 0.05, 'triangle', 0.025, 990)
  }
  ok() {
    this.tone(660, 0.1, 'triangle', 0.045)
    this.tone(990, 0.16, 'triangle', 0.045, undefined, 0.08)
  }
  bad() {
    this.tone(240, 0.28, 'sawtooth', 0.035, 120)
  }
  chime() {
    ;[523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.04, undefined, i * 0.09))
  }
  commit() {
    this.tone(392, 0.18, 'sine', 0.06)
    this.tone(784, 0.3, 'sine', 0.05, undefined, 0.1)
  }
  zap() {
    this.noise(0.25, 0.08, 3200)
    this.tone(1800, 0.2, 'sawtooth', 0.02, 300)
  }
  power() {
    this.tone(300, 0.9, 'sawtooth', 0.05, 30)
    this.noise(0.4, 0.05, 600)
  }
  boot() {
    ;[220, 330, 440].forEach((f, i) => this.tone(f, 0.25, 'sine', 0.05, undefined, i * 0.12))
  }
}
