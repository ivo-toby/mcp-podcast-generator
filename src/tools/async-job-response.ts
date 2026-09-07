/**
 * MCP dual-response helper for async job tools.
 *
 * Produces the shape the MCP server expects: a single `content` text block
 * containing pretty-printed JSON, plus matching `structuredContent`.
 * Optional `isError` flag for error paths.
 */

export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  /** MCP SDK requires structured content to be a JSON object when present. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Turn a JSON-serialisable object payload into the MCP dual-response shape.
 *
 * @param payload  – a JSON-serialisable object
 * @param isError  – when true the response is flagged as an error
 */
export function toMcpToolResult(
  payload: object,
  isError?: boolean,
): McpToolResult {
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [{ type: 'text' as const, text }],
    // Copy the object into an index-signature-shaped value required by the
    // MCP SDK. This keeps primitives from crossing the structured-content
    // boundary while preserving the caller's JSON representation.
    structuredContent: { ...payload },
    ...(isError ? { isError: true } : {}),
  };
}
