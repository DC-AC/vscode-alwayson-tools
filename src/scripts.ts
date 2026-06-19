/**
 * Builders for the ALTER AVAILABILITY GROUP statements. Ported directly from
 * the WinForms tool's Processchange routines so the emitted T-SQL is identical.
 */

/**
 * READ_ONLY_ROUTING_LIST for a replica's PRIMARY role.
 *
 * @param orderedReplicas the checked replicas in priority order.
 * @param roundRobin when true (SQL 2017+), wrap all replicas in a single
 *   load-balanced group: ('A','B','C') becomes (('A','B','C')).
 */
export function buildRoutingListScript(
  agName: string,
  replicaName: string,
  orderedReplicas: string[],
  roundRobin = false
): string {
  if (orderedReplicas.length === 0) {
    return (
      `ALTER AVAILABILITY GROUP [${agName}]\n` +
      `MODIFY REPLICA ON '${replicaName}'\n` +
      `WITH (PRIMARY_ROLE (READ_ONLY_ROUTING_LIST = NONE))`
    );
  }

  const quoted = orderedReplicas.map((r) => `'${r}'`);
  const list = roundRobin ? `(${quoted.join(', ')})` : quoted.join(', ');

  return (
    `ALTER AVAILABILITY GROUP [${agName}]\n` +
    `MODIFY REPLICA ON '${replicaName}'\n` +
    `WITH (PRIMARY_ROLE (READ_ONLY_ROUTING_LIST = (${list})))`
  );
}

/** READ_ONLY_ROUTING_URL for a replica's SECONDARY role, from a full URL. */
export function buildRoutingUrlStatement(
  agName: string,
  replicaServerName: string,
  url: string
): string {
  return (
    `ALTER AVAILABILITY GROUP [${agName}]\n` +
    `MODIFY REPLICA ON '${replicaServerName}'\n` +
    `WITH (SECONDARY_ROLE (READ_ONLY_ROUTING_URL='${url}'))`
  );
}

/** Compose a TCP routing URL from an FQDN and port. */
export function routingUrl(routingFqdn: string, tcpPort: number): string {
  return `TCP://${routingFqdn}:${tcpPort}`;
}

/** READ_ONLY_ROUTING_URL for a replica's SECONDARY role, from FQDN + port. */
export function buildRoutingUrlScript(
  agName: string,
  replicaServerName: string,
  routingFqdn: string,
  tcpPort: number
): string {
  return buildRoutingUrlStatement(agName, replicaServerName, routingUrl(routingFqdn, tcpPort));
}
