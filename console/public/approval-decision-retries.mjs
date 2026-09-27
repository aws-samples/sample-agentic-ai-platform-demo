// Persist only actor-scoped request identity + payload digest, never reason/token.
// A reload releases the local in-flight flag, not the server's durable reservation.
export function createApprovalDecisionRetries(storage) {
  const memory = new Map()
  const storageKey = key => `console.approval-retry.v1:${key}`
  const failure = () => new Error('Approval retry storage is unavailable. No decision was sent.')
  return {
    get(key) {
      if (memory.has(key)) return memory.get(key)
      let raw
      try { raw = storage.getItem(storageKey(key)) } catch { throw failure() }
      if (raw === null) return undefined
      let value
      try { value = JSON.parse(raw) } catch { throw failure() }
      if (!value || Object.keys(value).sort().join(',') !== 'fingerprint,requestId'
        || !/^[a-f0-9]{64}$/.test(value.fingerprint)
        || !/^[a-f0-9-]{36}$/.test(value.requestId)) throw failure()
      const pending = { ...value, inFlight: false }
      memory.set(key, pending)
      return pending
    },
    set(key, value) {
      try { storage.setItem(storageKey(key), JSON.stringify({fingerprint:value.fingerprint,requestId:value.requestId})) }
      catch { throw failure() }
      memory.set(key, value)
    },
    delete(key) {
      try { storage.removeItem(storageKey(key)) } catch { throw failure() }
      memory.delete(key)
    },
    clear() { memory.clear() },
  }
}
