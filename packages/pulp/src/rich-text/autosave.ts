/** Serializes full-state writes and acknowledges only the captured revision. */
export class Autosave {
  private revision = 0;
  private acknowledged = 0;
  private running = false;
  private epoch = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;

  constructor(private options: {
    save: () => void | Promise<void>;
    canSave: () => boolean;
    onError: (error: unknown) => void;
    delay?: number;
  }) {}

  changed() {
    this.revision++;
    this.schedule(this.options.delay ?? 30_000);
  }

  private schedule(delay: number) {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
  }

  async flush() {
    if (this.stopped || this.running || this.revision === this.acknowledged || !this.options.canSave()) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.running = true;
    const revision = this.revision;
    const epoch = ++this.epoch;
    try {
      await this.options.save();
      if (epoch !== this.epoch) return;
      this.acknowledged = revision;
      this.failures = 0;
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.failures++;
      this.options.onError(error);
    } finally {
      if (epoch === this.epoch) {
        this.running = false;
        if (this.revision !== this.acknowledged) {
          if (this.timer !== undefined) clearTimeout(this.timer);
          this.timer = undefined;
          this.schedule(this.failures ? Math.min(1000 * 2 ** Math.min(this.failures - 1, 6), 30_000) : 0);
        }
      }
    }
  }

  /** The SDK may leave reducer promises pending when the socket closes. */
  disconnected() {
    this.epoch++;
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  stop() {
    this.stopped = true;
    this.epoch++;
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
