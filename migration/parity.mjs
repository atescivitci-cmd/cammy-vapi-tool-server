// Advisory source readiness only. This module never changes routing or calls providers.
export function assessParity(inventory, evidence = {}) {
  const missing = [];
  if (inventory.schema !== 1) missing.push('inventory_schema');
  if (inventory.pipedream_source_complete !== true) missing.push('pipedream_source');
  if (inventory.current_assistant_config_verified !== true) missing.push('current_assistant_inventory');
  const required = new Set([
    ...inventory.render_endpoints.map(row => row.path),
    ...inventory.historical_tools.map(row => row.name),
    'transfer_to_ates',
  ]);
  for (const tool of required) {
    const receipt = evidence.tools?.[tool];
    if (receipt?.status !== 'verified' || !/^[a-f0-9]{64}$/.test(receipt?.receipt_sha256 ?? '')) missing.push(tool);
  }
  if (!/^[a-f0-9]{64}$/.test(evidence.owner_call_receipt_sha256 ?? '')) missing.push('owner_call_test');
  if (evidence.spend_limits_configured !== true) missing.push('spend_limits');
  return { ready: missing.length === 0, missing };
}
