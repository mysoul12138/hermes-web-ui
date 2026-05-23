type CanonicalConversationFactsInvalidator = () => void

const invalidators = new Set<CanonicalConversationFactsInvalidator>()

export function registerCanonicalConversationFactsInvalidator(invalidator: CanonicalConversationFactsInvalidator): () => void {
  invalidators.add(invalidator)
  return () => invalidators.delete(invalidator)
}

export function invalidateCanonicalConversationFactsCache(): void {
  for (const invalidator of invalidators) {
    try {
      invalidator()
    } catch {
      // Cache invalidation is best-effort; write paths must not fail because
      // a read-side cache owner was not initialized or has been unloaded.
    }
  }
}
