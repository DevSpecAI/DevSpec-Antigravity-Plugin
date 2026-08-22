/** Remove the per-connection secret and its version as one indivisible pair. */
export function stripConnectionCapability(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {}
  const {
    connection_capability: _capability,
    connection_capability_version: _version,
    ...rest
  } = state
  return rest
}

/** A missing or failed rotation revokes local use of every prior capability. */
export function applyConnectionCapabilityRotation(state, rotation) {
  const clean = stripConnectionCapability(state)
  return rotation?.ok === true
    ? {
        ...clean,
        connection_capability: rotation.value,
        connection_capability_version: rotation.version,
      }
    : clean
}
