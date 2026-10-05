/**
 * URL template resolver for the public-facing endpoint URLs shown in the
 * SELFbase UI (`ApiEndpointsSettings.tsx`) and emitted in `_schema` (OpenAPI)
 * documents.
 *
 * Templates use `{placeholder}` substitution. Recognised placeholders:
 *
 *   {origin}         e.g. https://selfbase.example.com
 *   {workspaceSlug}  e.g. acme
 *   {endpointSlug}   e.g. fruit
 *
 * Self-hosted SELFbase ships with the default template, which routes through
 * the in-app Next.js handler. Multi-tenant hosts override via the
 * `NEXT_PUBLIC_SELFBASE_API_URL_TEMPLATE` env var
 * (`NEXT_PUBLIC_PEAR_API_URL_TEMPLATE` still works as a fallback).
 */

export const DEFAULT_API_URL_TEMPLATE = "{origin}/api/e/{endpointSlug}";

export interface ResolveEndpointUrlArgs {
  template?: string | null;
  workspaceSlug: string;
  endpointSlug: string;
  origin: string;
}

export function resolveEndpointUrl(args: ResolveEndpointUrlArgs): string {
  const template = args.template?.trim() || DEFAULT_API_URL_TEMPLATE;
  return template
    .replaceAll("{origin}", args.origin.replace(/\/+$/, ""))
    .replaceAll("{workspaceSlug}", encodeURIComponent(args.workspaceSlug))
    .replaceAll("{endpointSlug}", encodeURIComponent(args.endpointSlug));
}

/**
 * `true` when the active template differs from the default — i.e. when
 * the operator has pointed the UI at an external gateway. The OSS Next.js
 * route uses this to self-disable (return 410) without needing a second
 * env var.
 */
export function isCustomTemplate(template: string | null | undefined): boolean {
  if (!template) return false;
  return template.trim() !== DEFAULT_API_URL_TEMPLATE;
}
