/**
 * STDB 2.0.3 materializes a caller-scoped view when it is directly queried or
 * subscribed. An HTTP-only caller's first RLS-protected read must evaluate the
 * corresponding permission view first. Subsequent dependency changes revoke
 * access even without an active WebSocket subscription.
 *
 * Evaluate once per token-bound transport. The host maintains dependencies
 * after evaluation. COUNT keeps the response small for large workspaces.
 */
export function readVisibilityViews(query: string): string[] {
    const projections: Array<[
        string,
        RegExp
    ]> = [
        ["readable_pages", /\b(?:page|page_content|page_yjs_state|attachment|page_snapshot|page_access_rule|block_access_rule|page_access_request|page_property_value|page_property_value_history|database_schema|database_view|component_node|database_row_marker)\b/i],
        ["readable_components", /\bcomponent_yjs_state\b/i],
        ["readable_schemas", /\bproperty_definition\b/i],
    ];
    return projections.filter(([, pattern]) => pattern.test(query)).map(([view]) => view);
}
