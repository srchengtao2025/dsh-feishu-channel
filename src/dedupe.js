export class ExpiringDedupe {
  constructor({ ttlMs = 10 * 60_000, maxEntries = 2_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.now = now
    this.entries = new Map()
  }

  seen(key) {
    const now = this.now()
    this.prune(now)
    if (this.entries.has(key)) return true
    this.entries.set(key, now + this.ttlMs)
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    return false
  }

  prune(now = this.now()) {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt > now) continue
      this.entries.delete(key)
    }
  }
}
